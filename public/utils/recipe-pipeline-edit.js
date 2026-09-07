// Pure draft edits. Relationships always use resource IDs, never labels/order.
const clone = value => JSON.parse(JSON.stringify(value));
let localIdSequence = 0;
// Like Task drafts, support the existing HTTP fallback where randomUUID may
// be unavailable. These recipe-local identifiers are not security tokens.
const id = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${++localIdSequence}-${Math.random().toString(36).slice(2)}`}`;

export function newOperation() {
  return { id: id('op'), label: '', consumes: [], requires: [], equipment: [], produces: [], duration: null, temperature: null };
}

export function bindIngredient(document, resourceId, recipe, sourceIndex) {
  const next = clone(document);
  const ingredient = recipe.ingredients?.[sourceIndex];
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || !ingredient) throw new Error('Choose an ingredient from the current recipe.');
  if (next.resources.some(resource => resource.kind === 'ingredient' && resource.id !== resourceId && resource.source_index === sourceIndex)) {
    throw new Error('This recipe ingredient is already in the pipeline. Divide it into portions instead of adding it twice.');
  }
  let resource = next.resources.find(item => item.id === resourceId);
  if (resource && resource.kind !== 'ingredient') throw new Error('Only ingredient resources can be linked to the written recipe.');
  if (!resource) { resource = { id: id('resource'), kind: 'ingredient' }; next.resources.push(resource); }
  Object.assign(resource, { name: ingredient.name, quantity: ingredient.quantity || '', source_index: sourceIndex });
  return next;
}

export function addOutput(document, operationId, kind = 'component') {
  const next = clone(document);
  const operation = next.operations.find(item => item.id === operationId);
  if (!operation) throw new Error('Choose an operation first.');
  const resource = { id: id('resource'), kind, name: '', quantity: '', source_index: null };
  next.resources.push(resource);
  operation.produces.push(resource.id);
  return { document: next, resourceId: resource.id };
}

export function removeOutput(document, resourceId) {
  const next = clone(document);
  const users = next.operations.filter(operation => operation.consumes.includes(resourceId) || operation.requires.includes(resourceId));
  if (users.length) throw new Error(`This output is still used by ${users.map(operation => operation.label || 'an unnamed operation').join(', ')}. Choose a replacement input there first.`);
  next.resources = next.resources.filter(resource => resource.id !== resourceId);
  for (const operation of next.operations) operation.produces = operation.produces.filter(value => value !== resourceId);
  return next;
}

export function removeOperation(document, operationId) {
  let next = clone(document);
  const operation = next.operations.find(item => item.id === operationId);
  if (!operation) return next;
  next.operations = next.operations.filter(item => item.id !== operationId);
  for (const output of operation.produces) next = removeOutput(next, output);
  return next;
}

export function moveOperation(document, operationId, direction) {
  const next = clone(document);
  const index = next.operations.findIndex(item => item.id === operationId);
  const other = index + direction;
  if (index >= 0 && other >= 0 && other < next.operations.length) {
    [next.operations[index], next.operations[other]] = [next.operations[other], next.operations[index]];
  }
  return next;
}

export function divideResource(document, resourceId, portions) {
  const next = clone(document);
  const resource = next.resources.find(item => item.id === resourceId);
  if (!resource || resource.kind === 'readiness') throw new Error('Choose an ingredient or food component to divide.');
  if (portions.length < 2 || portions.some(portion => !portion.name?.trim())) throw new Error('Name at least two portions.');
  const consumer = next.operations.find(operation => operation.consumes.includes(resourceId));
  const operation = newOperation();
  operation.label = `Divide ${resource.name}`;
  operation.consumes = [resourceId];
  for (const portion of portions) {
    const output = { id: id('resource'), kind: 'component', name: portion.name.trim(), quantity: portion.quantity?.trim() || '', source_index: null };
    next.resources.push(output);
    operation.produces.push(output.id);
  }
  // The first portion replaces the existing use, visibly explained by the editor.
  if (consumer) consumer.consumes = consumer.consumes.map(value => value === resourceId ? operation.produces[0] : value);
  const insertAt = consumer ? next.operations.indexOf(consumer) : next.operations.length;
  next.operations.splice(insertAt, 0, operation);
  return { document: next, operationId: operation.id };
}
