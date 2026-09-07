// A recipe pipeline records authored resource transformations. Operation edges
// are derived from resource producers; equipment and display order add no edges.
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESOURCE_KINDS = new Set(['ingredient', 'component', 'readiness']);
const YEAR_SECONDS = 365 * 24 * 60 * 60;

function plainObject(value, keys, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${context} must be an object.`);
  }
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${context} contains an unsupported field.`);
}

function inlineText(value, limit, context, allowEmpty = false) {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${context} must be plain text.`);
  }
  const result = value.replace(/\s+/g, ' ').trim();
  if ((!allowEmpty && !result) || result.length > limit) {
    throw new Error(`${context} must contain ${allowEmpty ? 'at most' : '1 to'} ${limit} characters.`);
  }
  return result;
}

function identifier(value, context) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new Error(`${context} must start with a letter and use only letters, numbers, hyphens or underscores (up to 64 characters).`);
  }
  return value;
}

function referenceList(value, context, { required = false } = {}) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > 300 || (required && !value.length)) {
    throw new Error(`${context} must contain ${required ? '1 to' : 'at most'} 300 resources.`);
  }
  const result = value.map(id => identifier(id, context));
  if (new Set(result).size !== result.length) throw new Error(`${context} contains a duplicate resource.`);
  return result;
}

function durationValue(value) {
  if (value === undefined || value === null) return null;
  plainObject(value, ['min_seconds', 'max_seconds'], 'Duration');
  for (const seconds of [value.min_seconds, value.max_seconds]) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > YEAR_SECONDS) {
      throw new Error('Duration must use seconds between 0 and one year, or be blank.');
    }
  }
  if (value.min_seconds > value.max_seconds) throw new Error('The minimum duration cannot exceed the maximum duration.');
  return { min_seconds: value.min_seconds, max_seconds: value.max_seconds };
}

function temperatureValue(value) {
  if (value === undefined || value === null) return null;
  plainObject(value, ['value', 'unit'], 'Temperature');
  if (!['C', 'F'].includes(value.unit)) throw new Error('Temperature unit must be C or F.');
  const minimum = value.unit === 'C' ? -273.15 : -459.67;
  const maximum = value.unit === 'C' ? 2000 : 3632;
  if (typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < minimum || value.value > maximum) {
    throw new Error(`Temperature must be a number from ${minimum} to ${maximum}°${value.unit}, or be blank.`);
  }
  return { value: value.value, unit: value.unit };
}

function resourceValue(resource, index) {
  plainObject(resource, ['id', 'kind', 'name', 'quantity', 'source_index'], `Resource ${index + 1}`);
  if (!RESOURCE_KINDS.has(resource.kind)) throw new Error('Resource kind must be ingredient, component or readiness.');
  const sourceIndex = resource.source_index ?? null;
  if (sourceIndex !== null && (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0)) {
    throw new Error('Ingredient source position must be a nonnegative whole number, or blank.');
  }
  if (resource.kind !== 'ingredient' && sourceIndex !== null) throw new Error('Only ingredients can refer to a recipe ingredient source.');
  return {
    id: identifier(resource.id, 'Resource ID'),
    kind: resource.kind,
    name: inlineText(resource.name, 500, 'Resource name'),
    quantity: inlineText(resource.quantity ?? '', 100, 'Resource quantity', true),
    source_index: sourceIndex,
  };
}

function operationValue(operation, index) {
  plainObject(operation, ['id', 'label', 'consumes', 'requires', 'equipment', 'produces', 'duration', 'temperature'], `Operation ${index + 1}`);
  const suppliedEquipment = operation.equipment === undefined ? [] : operation.equipment;
  if (!Array.isArray(suppliedEquipment) || suppliedEquipment.length > 20) throw new Error('Equipment must be a list of at most 20 items.');
  const equipment = suppliedEquipment.map(name => inlineText(name, 100, 'Equipment name'));
  if (new Set(equipment.map(name => name.toLocaleLowerCase('en'))).size !== equipment.length) throw new Error('Equipment contains a duplicate item.');
  return {
    id: identifier(operation.id, 'Operation ID'),
    label: inlineText(operation.label, 500, 'Operation name'),
    consumes: referenceList(operation.consumes, 'Consumed ingredients and components'),
    requires: referenceList(operation.requires, 'Required preparation'),
    equipment,
    produces: referenceList(operation.produces, 'Operation outputs', { required: true }),
    duration: durationValue(operation.duration),
    temperature: temperatureValue(operation.temperature),
  };
}

function graphIndex(pipeline) {
  const resources = new Map(pipeline.resources.map(resource => [resource.id, resource]));
  const operations = new Map(pipeline.operations.map(operation => [operation.id, operation]));
  if (resources.size !== pipeline.resources.length) throw new Error('Each resource must have a unique ID.');
  if (operations.size !== pipeline.operations.length) throw new Error('Each operation must have a unique ID.');
  const sourceIndexes = pipeline.resources.filter(resource => resource.source_index !== null).map(resource => resource.source_index);
  if (new Set(sourceIndexes).size !== sourceIndexes.length) throw new Error('A recipe ingredient source can appear only once. Divide it into portions when needed.');

  const producers = new Map();
  const users = new Map();
  for (const operation of pipeline.operations) {
    for (const id of operation.produces) {
      const resource = resources.get(id);
      if (!resource) throw new Error(`“${operation.label}” produces a resource that does not exist.`);
      if (resource.kind === 'ingredient') throw new Error('Ingredients are starting resources and cannot be produced by an operation.');
      if (producers.has(id)) throw new Error(`“${resource.name}” has more than one producer. Give each result its own resource.`);
      producers.set(id, operation.id);
    }
    for (const kind of ['consumes', 'requires']) {
      for (const id of operation[kind]) {
        const resource = resources.get(id);
        if (!resource) throw new Error(`“${operation.label}” refers to a resource that does not exist.`);
        if (kind === 'consumes' && resource.kind === 'readiness') throw new Error('Prepared equipment and other prerequisites belong under Required preparation, not Consumes.');
        if (kind === 'requires' && resource.kind !== 'readiness') throw new Error('Ingredients and components belong under Consumes, not Required preparation.');
        if (operation.produces.includes(id)) throw new Error('An operation cannot use its own output. Give the changed result a new resource.');
        if (kind === 'consumes' && users.has(id)) throw new Error(`“${resource.name}” is consumed more than once. Add a Divide operation with separate portion outputs.`);
        if (!users.has(id)) users.set(id, []);
        users.get(id).push({ operation: operation.id, kind });
      }
    }
  }
  for (const resource of pipeline.resources) {
    if (resource.kind !== 'ingredient' && !producers.has(resource.id)) throw new Error(`“${resource.name}” needs an operation that produces it.`);
  }
  const edges = [];
  for (const operation of pipeline.operations) {
    for (const kind of ['consumes', 'requires']) {
      for (const resource of operation[kind]) {
        const from = producers.get(resource);
        if (from) edges.push({ from, to: operation.id, resource, kind });
      }
    }
  }
  const dependencies = new Map(pipeline.operations.map(operation => [operation.id, new Set()]));
  for (const edge of edges) dependencies.get(edge.to).add(edge.from);
  return { producers, users, edges, dependencies };
}

function topologicalLayers(pipeline, dependencies) {
  const finished = new Set();
  const layers = [];
  while (finished.size < pipeline.operations.length) {
    const layer = pipeline.operations.filter(operation => !finished.has(operation.id)
      && [...dependencies.get(operation.id)].every(id => finished.has(id)));
    if (!layer.length) throw new Error('These resource connections form a loop. Change an input or output so each operation can be reached.');
    layers.push(layer);
    layer.forEach(operation => finished.add(operation.id));
  }
  return layers;
}

/** Validate authored data and return a normalized copy. Empty drafts cannot be saved. */
export function validatePipeline(document) {
  plainObject(document, ['schema_version', 'resources', 'operations'], 'Pipeline');
  if (document.schema_version !== 1) throw new Error('This pipeline version is not supported.');
  if (!Array.isArray(document.resources) || !document.resources.length || document.resources.length > 300) throw new Error('A pipeline must contain 1 to 300 resources.');
  if (!Array.isArray(document.operations) || !document.operations.length || document.operations.length > 100) throw new Error('A pipeline must contain 1 to 100 operations.');
  const pipeline = {
    schema_version: 1,
    resources: document.resources.map(resourceValue),
    operations: document.operations.map(operationValue),
  };
  const { dependencies } = graphIndex(pipeline);
  topologicalLayers(pipeline, dependencies);
  return pipeline;
}

/** Edges come only from the sole producer of each explicitly selected input. */
export function derivePipeline(document) {
  const pipeline = validatePipeline(document);
  const { edges, dependencies, producers, users } = graphIndex(pipeline);
  const layers = topologicalLayers(pipeline, dependencies);
  return {
    pipeline,
    edges,
    layers,
    order: layers.flat(),
    ready: [...layers[0]],
    terminalResources: pipeline.resources.filter(resource => producers.has(resource.id) && !users.has(resource.id)),
    unusedIngredients: pipeline.resources.filter(resource => resource.kind === 'ingredient' && !users.has(resource.id)),
  };
}

/** Readiness follows each operation's own inputs, not a barrier between columns. */
export function readyOperations(document, completedIds = []) {
  const { pipeline, edges } = derivePipeline(document);
  if (!Array.isArray(completedIds) && !(completedIds instanceof Set)) throw new Error('Completed operations must be a list of operation IDs.');
  const completed = new Set(completedIds);
  const ids = new Set(pipeline.operations.map(operation => operation.id));
  if ([...completed].some(id => !ids.has(id))) throw new Error('A completed operation no longer exists in this pipeline.');
  return pipeline.operations.filter(operation => !completed.has(operation.id)
    && edges.filter(edge => edge.to === operation.id).every(edge => completed.has(edge.from)));
}

const sourceText = value => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Only cooking source data affects stale-review detection; SQL IDs never do. */
export function pipelineSource(recipe) {
  return JSON.stringify({
    notes: String(recipe?.notes ?? '').replace(/\r\n?/g, '\n').trim(),
    ingredients: (Array.isArray(recipe?.ingredients) ? recipe.ingredients : []).map(ingredient => ({
      name: sourceText(ingredient?.name),
      quantity: sourceText(ingredient?.quantity),
    })),
  });
}

/** Ingredient snapshots only. No operations, quantities or ordering are inferred. */
export function createPipelineDraft(recipe) {
  const source = JSON.parse(pipelineSource(recipe));
  if (source.ingredients.length > 300) throw new Error('A pipeline can contain at most 300 resources. Reduce the ingredient list before starting.');
  return {
    schema_version: 1,
    resources: source.ingredients.map((ingredient, index) => resourceValue({
      id: `ingredient-${index + 1}`,
      kind: 'ingredient',
      name: ingredient.name,
      quantity: ingredient.quantity,
      source_index: index,
    }, index)),
    operations: [],
  };
}
