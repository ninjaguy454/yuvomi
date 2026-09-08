import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePipeline, derivePipeline } from '../public/utils/recipe-pipeline.js';
import { newOperation, divideResource, moveOperation, reorderOperation, readyStateChoices, removeOperation, addOutput, removeOutput, bindIngredient } from '../public/utils/recipe-pipeline-edit.js';
import { operationFields, operationPicker } from '../public/components/recipe-pipeline-editor.js';

const base = () => ({ schema_version: 1, resources: [
  { id: 'flour', kind: 'ingredient', name: 'Flour', quantity: '200 g', source_index: 0 },
  { id: 'dough', kind: 'component', name: 'Dough', quantity: '', source_index: null },
  { id: 'loaf', kind: 'component', name: 'Loaf', quantity: '', source_index: null },
], operations: [
  { id: 'mix', label: 'Make dough', consumes: ['flour'], requires: [], produces: ['dough'], equipment: ['Bowl'], duration: null, temperature: null },
  { id: 'bake', label: 'Bake', consumes: ['dough'], requires: [], produces: ['loaf'], equipment: ['Oven'], duration: null, temperature: null },
] });

test('HTTP fallback can author unique stable IDs without crypto.randomUUID', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  try {
    const first = newOperation(), second = newOperation();
    assert.notEqual(first.id, second.id);
    const { document, resourceId } = addOutput(base(), 'bake');
    document.resources.find(resource => resource.id === resourceId).name = 'Cooling rack ready';
    validatePipeline(document);
    assert.equal(validatePipeline(document).operations[1].produces.at(-1), resourceId);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
});

test('Adding the same written ingredient twice is rejected instead of duplicating its quantity', () => {
  assert.throws(() => bindIngredient(base(), null, { ingredients: [{ name: 'Flour', quantity: '200 g' }] }, 0), /already in the pipeline/);
});

test('Explicit ingredient relinking refreshes its snapshot without changing downstream IDs', () => {
  const original = base();
  const next = bindIngredient(original, 'flour', { ingredients: [{ name: 'Wholemeal flour', quantity: '220 g' }] }, 0);
  assert.equal(next.resources[0].name, 'Wholemeal flour');
  assert.equal(next.resources[0].quantity, '220 g');
  assert.equal(next.resources[0].source_index, 0);
  assert.equal(next.operations[0].consumes[0], 'flour');
  assert.deepEqual(derivePipeline(next).edges, derivePipeline(original).edges);
});

test('Dividing an already-used ingredient transfers its existing use to the first portion', () => {
  const original = base();
  const { document, operationId } = divideResource(original, 'flour', [{ name: 'Flour for dough', quantity: '180 g' }, { name: 'Flour for dusting', quantity: '20 g' }]);
  const graph = derivePipeline(document);
  const split = graph.order.find(operation => operation.id === operationId);
  assert.equal(graph.order.find(operation => operation.id === 'mix').consumes[0], split.produces[0]);
  assert.deepEqual(split.consumes, ['flour']);
  assert.ok(graph.edges.some(edge => edge.from === operationId && edge.to === 'mix'));
  assert.equal(graph.terminalResources.find(resource => resource.id === split.produces[1]).quantity, '20 g');
  assert.equal(original.operations[0].consumes[0], 'flour');
});

test('Division requires named portions and rejects reusable readiness', () => {
  assert.throws(() => divideResource(base(), 'flour', [{ name: '' }, { name: 'Dusting' }]), /Name/);
  const document = base(); document.resources[0].kind = 'readiness';
  assert.throws(() => divideResource(document, 'flour', [{ name: 'A' }, { name: 'B' }]), /ingredient or food/);
});

test('Reordering preserves the derived cooking order', () => {
  const document = moveOperation(base(), 'bake', -1);
  assert.equal(document.operations[0].id, 'bake');
  assert.deepEqual(derivePipeline(document).order.map(operation => operation.id), ['mix', 'bake']);
});

test('Used outputs and their producers cannot be silently removed', () => {
  assert.throws(() => removeOutput(base(), 'dough'), /Bake/);
  assert.throws(() => removeOperation(base(), 'mix'), /Bake/);
});

test('Removing terminal operation removes its unused output without changing prior resources', () => {
  const document = removeOperation(base(), 'bake');
  assert.equal(validatePipeline(document).operations.length, 1);
  assert.deepEqual(document.resources.map(resource => resource.id), ['flour', 'dough']);
});

test('Output rename preserves every resource reference', () => {
  const document = base(); const before = derivePipeline(document).edges;
  document.resources.find(resource => resource.id === 'dough').name = 'Wholemeal dough';
  assert.deepEqual(derivePipeline(document).edges, before);
  assert.match(operationFields(document, 'bake'), /Wholemeal dough/);
});

test('New ready outputs stay distinct from equipment and food inputs', () => {
  const { document, resourceId } = addOutput(base(), 'mix', 'readiness');
  document.resources.find(resource => resource.id === resourceId).name = 'Workspace ready';
  document.operations[1].requires.push(resourceId);
  validatePipeline(document);
  const html = operationFields(document, 'bake');
  assert.match(html, new RegExp(`data-input-kind="requires" value="${resourceId}" checked`));
  assert.doesNotMatch(html, new RegExp(`data-input-kind="consumes" value="${resourceId}"`));
  assert.match(html, /Equipment \(one per line\)/);
});

test('Editor escapes recipe text and does not expose dependency ID controls', () => {
  const document = base();
  document.resources[0].name = '<img src=x onerror=alert(1)>';
  document.operations[0].label = '</textarea><script>alert(1)</script>';
  const html = operationFields(document, 'mix');
  assert.doesNotMatch(html, /<script>|<img src/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /depends_on|data-dependency/);
});

test('Reordering does not repair or discard invalid references or cyclic connections', () => {
  const cyclic = base();
  cyclic.operations[0].consumes.push('loaf');
  const movedCycle = reorderOperation(cyclic, 'bake', 0);
  assert.deepEqual(movedCycle.operations.find(operation => operation.id === 'mix').consumes, ['flour', 'loaf']);
  assert.throws(() => validatePipeline(movedCycle), /loop/i);
  const invalid = base();
  invalid.operations[1].requires.push('missing-ready-state');
  const movedInvalid = reorderOperation(invalid, 'bake', 0);
  assert.deepEqual(movedInvalid.operations[0].requires, ['missing-ready-state']);
  assert.throws(() => validatePipeline(movedInvalid), /unknown|missing|not exist/i);
});

const readyFixture = () => ({ ...base(), resources: [...base().resources,
  { id: 'pan-ready', kind: 'readiness', name: 'Pan prepared', quantity: '', source_index: null },
  { id: 'oven-ready', kind: 'readiness', name: 'Oven preheated', quantity: '', source_index: null },
], operations: [
  { ...newOperation(), id: 'preheat', label: 'Preheat oven', produces: ['oven-ready'] },
  ...base().operations,
  { ...newOperation(), id: 'pan', label: 'Prepare pan', produces: ['pan-ready'] },
] });

test('ready choices follow current producer order and reveal newly earlier states after arbitrary moves', () => {
  const original = readyFixture();
  assert.deepEqual(readyStateChoices(original, 'bake').map(choice => choice.resource.id), ['oven-ready']);
  const reordered = reorderOperation(original, 'pan', 0);
  assert.deepEqual(reordered.operations.map(operation => operation.id), ['pan', 'preheat', 'mix', 'bake']);
  assert.deepEqual(readyStateChoices(reordered, 'bake').map(choice => choice.resource.id), ['pan-ready', 'oven-ready']);
  assert.deepEqual(readyStateChoices(reordered, 'preheat').map(choice => choice.resource.id), ['pan-ready']);
  assert.deepEqual(original.operations.map(operation => operation.id), ['preheat', 'mix', 'bake', 'pan']);
});

test('a selected prerequisite remains checked with a later note when its producer is moved later', () => {
  const original = readyFixture(); original.operations.find(operation => operation.id === 'bake').requires = ['oven-ready'];
  const reordered = reorderOperation(original, 'preheat', 3);
  const choices = readyStateChoices(reordered, 'bake');
  assert.equal(choices.length, 1); assert.equal(choices[0].later, true); assert.equal(choices[0].selected, true);
  assert.match(operationFields(reordered, 'bake'), /data-input-kind="requires" value="oven-ready" checked/);
  assert.match(operationFields(reordered, 'bake'), /Shown later in the list: Preheat oven/);
  assert.deepEqual(validatePipeline(reordered).operations.find(operation => operation.id === 'bake').requires, ['oven-ready']);
  assert.ok(derivePipeline(reordered).edges.some(edge => edge.from === 'preheat' && edge.to === 'bake'));
});

test('adding, renaming and removing readiness output refreshes choices without changing reference IDs', () => {
  const added = addOutput(base(), 'mix', 'readiness');
  assert.equal(readyStateChoices(added.document, 'bake')[0].resource.id, added.resourceId);
  added.document.resources.find(resource => resource.id === added.resourceId).name = 'Bench cleaned';
  added.document.operations[0].label = 'Clean and mix';
  assert.match(operationFields(added.document, 'bake'), /Bench cleaned/);
  assert.match(operationFields(added.document, 'bake'), /Prepared by: Clean and mix/);
  assert.equal(readyStateChoices(added.document, 'mix').length, 0, 'an operation cannot require its own ready output');
  const removed = removeOutput(added.document, added.resourceId);
  assert.equal(readyStateChoices(removed, 'bake').length, 0);
  added.document.operations[1].requires = [added.resourceId];
  assert.throws(() => removeOutput(added.document, added.resourceId), /still used/);
});

test('operation picker offers compact named keyboard controls and a separate drag handle', () => {
  const html = operationPicker(base(), 'mix');
  assert.match(html, /data-operation-row="mix"/);
  assert.match(html, /class="pipeline-operation-handle" role="img"/);
  assert.match(html, /data-command="up" data-move-operation="mix" aria-label="Move operation 1 up" disabled/);
  assert.match(html, /data-command="down" data-move-operation="mix" aria-label="Move operation 1 down"/);
  assert.match(html, /data-lucide="chevron-up"/); assert.match(html, /data-lucide="chevron-down"/);
  assert.doesNotMatch(html, />Move up<|>Move down</);
});
