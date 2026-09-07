import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPipelineDraft, derivePipeline, pipelineSource, readyOperations, validatePipeline,
} from '../public/utils/recipe-pipeline.js';
import {
  bananaBread, cooling, dough, recipePipelineFixtures, separateSauce, sequential, stovetopAndOven,
} from './fixtures/recipe-pipeline.js';

const copy = value => structuredClone(value);
const ids = values => values.map(value => value.id);
const pairs = graph => derivePipeline(graph).edges.map(edge => `${edge.from}->${edge.to}:${edge.resource}:${edge.kind}`);
const component = (id, name = id) => ({ id, kind: 'component', name });
const readiness = (id, name = id) => ({ id, kind: 'readiness', name });
const operation = (id, consumes, produces, options = {}) => ({ id, label: id, consumes, produces, ...options });

for (const [name, { pipeline }] of Object.entries(recipePipelineFixtures)) {
  test(`authored ${name} fixture is a complete acyclic resource pipeline`, () => {
    const result = derivePipeline(pipeline);
    assert.equal(result.order.length, pipeline.operations.length);
    assert.equal(new Set(ids(result.order)).size, pipeline.operations.length);
    const positions = new Map(result.order.map((entry, index) => [entry.id, index]));
    for (const edge of result.edges) assert.ok(positions.get(edge.from) < positions.get(edge.to), `${edge.from} precedes ${edge.to}`);
    assert.equal(result.unusedIngredients.length, 0);
    assert.ok(result.terminalResources.some(resource => resource.kind === 'component'));
  });
}

test('simple sequential operations derive exactly the transformations, in order', () => {
  const result = derivePipeline(sequential.pipeline);
  assert.deepEqual(result.layers.map(ids), [['wash'], ['chop'], ['steam']]);
  assert.deepEqual(result.edges, [
    { from: 'wash', to: 'chop', resource: 'washed', kind: 'consumes' },
    { from: 'chop', to: 'steam', resource: 'chopped', kind: 'consumes' },
  ]);
  assert.deepEqual(ids(result.terminalResources), ['cooked']);
});

test('banana bread has parallel prep, explicit portions, two convergences and cooling', () => {
  const result = derivePipeline(bananaBread.pipeline);
  assert.deepEqual(ids(result.ready), ['preheat', 'divide-butter', 'divide-flour', 'mash', 'beat']);
  assert.deepEqual(result.layers.map(ids), [
    ['preheat', 'divide-butter', 'divide-flour', 'mash', 'beat'],
    ['prepare-pan', 'melt', 'whisk'],
    ['mix-wet'], ['fold'], ['fill-pan'], ['bake'], ['cool-pan'], ['cool-rack'],
  ]);
  assert.deepEqual(result.edges.filter(edge => edge.to === 'mix-wet').map(edge => edge.from), ['mash', 'melt', 'beat']);
  assert.deepEqual(result.edges.filter(edge => edge.to === 'fold').map(edge => edge.from), ['mix-wet', 'whisk']);
  assert.ok(pairs(bananaBread.pipeline).includes('divide-butter->prepare-pan:butter-pan:consumes'));
  assert.ok(pairs(bananaBread.pipeline).includes('divide-butter->melt:butter-batter:consumes'));
  assert.ok(pairs(bananaBread.pipeline).includes('divide-flour->whisk:flour-batter:consumes'));
  assert.ok(pairs(bananaBread.pipeline).includes('prepare-pan->fill-pan:pan-ready:requires'));
  assert.ok(pairs(bananaBread.pipeline).includes('preheat->bake:oven-ready:requires'));
  assert.ok(pairs(bananaBread.pipeline).includes('bake->cool-pan:hot-loaf:consumes'));
  assert.ok(pairs(bananaBread.pipeline).includes('cool-pan->cool-rack:warm-loaf:consumes'));
  assert.deepEqual(ids(result.terminalResources), ['cooled-loaf']);
});

test('resting and rising remain separate material states, with unknown rise time', () => {
  const result = derivePipeline(dough.pipeline);
  assert.ok(pairs(dough.pipeline).includes('knead->rest:kneaded:consumes'));
  assert.ok(pairs(dough.pipeline).includes('rest->shape:rested:consumes'));
  assert.ok(pairs(dough.pipeline).includes('shape->rise:shaped:consumes'));
  assert.ok(pairs(dough.pipeline).includes('rise->bake:risen:consumes'));
  assert.equal(result.pipeline.operations.find(entry => entry.id === 'rise').duration, null);
  assert.equal(result.pipeline.operations.find(entry => entry.id === 'preheat').duration, null);
});

test('stovetop and oven branches converge only when both components exist', () => {
  const result = derivePipeline(stovetopAndOven.pipeline);
  assert.deepEqual(ids(result.ready), ['preheat', 'chop', 'cook-rice']);
  assert.deepEqual(result.edges.filter(edge => edge.to === 'combine').map(edge => edge.from), ['roast', 'cook-rice']);
  assert.equal(result.edges.some(edge => edge.from === 'roast' && edge.to === 'cook-rice'), false);
  assert.equal(result.edges.some(edge => edge.from === 'cook-rice' && edge.to === 'roast'), false);
});

test('separate sauce and pasta share a stove annotation without an invented edge', () => {
  const result = derivePipeline(separateSauce.pipeline);
  assert.deepEqual(ids(result.ready), ['cook-pasta', 'chop-onion']);
  assert.deepEqual(result.edges.filter(edge => edge.to === 'combine').map(edge => edge.from), ['cook-pasta', 'simmer-sauce']);
  assert.equal(result.edges.some(edge => edge.from === 'cook-pasta' && edge.to === 'simmer-sauce'), false);
});

test('cooling durations keep their authored range and final chill duration', () => {
  const result = derivePipeline(cooling.pipeline);
  assert.deepEqual(result.layers.map(ids), [['cook'], ['cool'], ['chill']]);
  assert.equal(result.pipeline.operations[0].duration, null);
  assert.deepEqual(result.pipeline.operations[1].duration, { min_seconds: 1200, max_seconds: 1800 });
  assert.deepEqual(result.pipeline.operations[2].duration, { min_seconds: 7200, max_seconds: 7200 });
});

test('renaming resources and actions leaves every edge and stable ID unchanged', () => {
  const renamed = copy(bananaBread.pipeline);
  renamed.resources.forEach(resource => { resource.name = 'A deliberately identical name'; });
  renamed.operations.forEach(entry => { entry.label = 'Combine or bake, whichever the author names'; });
  assert.deepEqual(derivePipeline(renamed).edges, derivePipeline(bananaBread.pipeline).edges);
  assert.deepEqual(derivePipeline(renamed).layers.map(ids), derivePipeline(bananaBread.pipeline).layers.map(ids));
});

test('authored array order breaks ties only; it cannot override resource prerequisites', () => {
  const reordered = copy(bananaBread.pipeline);
  reordered.operations.reverse();
  const result = derivePipeline(reordered);
  assert.deepEqual(ids(result.ready), ['beat', 'mash', 'divide-flour', 'divide-butter', 'preheat']);
  assert.deepEqual(ids(result.order).slice(-3), ['bake', 'cool-pan', 'cool-rack']);
});

test('an existing producer edge appears only after explicitly selecting its resource', () => {
  const pipeline = {
    schema_version: 1,
    resources: [readiness('heated'), component('first'), component('second')],
    operations: [operation('preheat', [], ['heated']), operation('first-cook', [], ['first']), operation('second-cook', [], ['second'])],
  };
  assert.equal(derivePipeline(pipeline).edges.length, 0);
  pipeline.operations[1].requires = ['heated'];
  assert.deepEqual(derivePipeline(pipeline).edges, [{ from: 'preheat', to: 'first-cook', resource: 'heated', kind: 'requires' }]);
  assert.equal(derivePipeline(pipeline).ready.some(entry => entry.id === 'second-cook'), true);
});

test('readiness may be required by multiple operations, equipment adds no edges', () => {
  const pipeline = {
    schema_version: 1,
    resources: [readiness('oven'), component('roast'), component('cake')],
    operations: [
      operation('preheat', [], ['oven'], { equipment: ['Oven'] }),
      operation('roast', [], ['roast'], { requires: ['oven'], equipment: ['Oven'] }),
      operation('bake', [], ['cake'], { requires: ['oven'], equipment: ['Oven'] }),
    ],
  };
  const result = derivePipeline(pipeline);
  assert.deepEqual(result.layers.map(ids), [['preheat'], ['roast', 'bake']]);
  assert.equal(result.edges.length, 2);
  assert.equal(result.edges.every(edge => edge.kind === 'requires'), true);
});

test('several resources from one producer retain distinct edges but one prerequisite', () => {
  const pipeline = {
    schema_version: 1,
    resources: [component('portion-a'), component('portion-b'), component('result')],
    operations: [operation('prepare', [], ['portion-a', 'portion-b']), operation('combine', ['portion-a', 'portion-b'], ['result'])],
  };
  const result = derivePipeline(pipeline);
  assert.equal(result.edges.length, 2);
  assert.deepEqual(result.layers.map(ids), [['prepare'], ['combine']]);
  assert.deepEqual(ids(readyOperations(pipeline, ['prepare'])), ['combine']);
});

test('ready operations depend on their own prerequisites, not completion of a whole stage', () => {
  assert.deepEqual(ids(readyOperations(bananaBread.pipeline)), ids(derivePipeline(bananaBread.pipeline).ready));
  const result = ids(readyOperations(bananaBread.pipeline, ['divide-butter']));
  assert.ok(result.includes('melt'));
  assert.ok(result.includes('divide-flour'));
  assert.equal(result.includes('prepare-pan'), false);
  assert.equal(result.includes('mix-wet'), false);
  assert.equal(result.includes('divide-butter'), false);
  assert.deepEqual(readyOperations(bananaBread.pipeline, new Set(ids(bananaBread.pipeline.operations))), []);
});

test('unknown or malformed completed operation identities are rejected', () => {
  assert.throws(() => readyOperations(sequential.pipeline, ['unknown']), /no longer exists/);
  assert.throws(() => readyOperations(sequential.pipeline, 'wash'), /must be a list/);
});

test('unused ingredients and unconsumed produced resources remain visible for review', () => {
  const pipeline = copy(sequential.pipeline);
  pipeline.resources.push({ id: 'garnish', kind: 'ingredient', name: 'Optional parsley', quantity: 'To taste' });
  pipeline.resources.push(readiness('unused-tray'));
  pipeline.operations.push(operation('prepare-tray', [], ['unused-tray']));
  const result = derivePipeline(pipeline);
  assert.deepEqual(ids(result.unusedIngredients), ['garnish']);
  assert.deepEqual(ids(result.terminalResources), ['cooked', 'unused-tray']);
});

test('normalization copies caller data and supplies optional display fields', () => {
  const input = {
    schema_version: 1,
    resources: [{ id: 'dish', kind: 'component', name: ' Finished   dish ' }],
    operations: [{ id: 'serve', label: ' Prepare  a plate ', produces: ['dish'] }],
  };
  const before = copy(input);
  const result = validatePipeline(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.resources[0], { id: 'dish', kind: 'component', name: 'Finished dish', quantity: '', source_index: null });
  assert.deepEqual(result.operations[0], {
    id: 'serve', label: 'Prepare a plate', consumes: [], requires: [], equipment: [], produces: ['dish'], duration: null, temperature: null,
  });
  result.operations[0].produces.push('different');
  assert.deepEqual(input.operations[0].produces, ['dish']);
});

const invalidChanges = [
  ['duplicate resource IDs', graph => graph.resources.push(copy(graph.resources[0])), /unique ID/],
  ['duplicate operation IDs', graph => graph.operations.push(copy(graph.operations[0])), /unique ID/],
  ['unsafe resource ID', graph => { graph.resources[0].id = '<unsafe>'; }, /Resource ID/],
  ['unsafe operation ID', graph => { graph.operations[0].id = '9-step'; }, /Operation ID/],
  ['blank resource name', graph => { graph.resources[0].name = ' '; }, /Resource name/],
  ['blank action label', graph => { graph.operations[0].label = ''; }, /Operation name/],
  ['overlong action label', graph => { graph.operations[0].label = 'x'.repeat(501); }, /Operation name/],
  ['overlong quantity', graph => { graph.resources[0].quantity = 'x'.repeat(101); }, /Resource quantity/],
  ['text control characters', graph => { graph.resources[0].name = 'carrot\u0000'; }, /plain text/],
  ['unknown resource kind', graph => { graph.resources[0].kind = 'equipment'; }, /Resource kind/],
  ['unknown top-level fields', graph => { graph.depends_on = []; }, /unsupported field/],
  ['manual edge field', graph => { graph.operations[0].depends_on = ['steam']; }, /unsupported field/],
  ['parallel boolean', graph => { graph.operations[0].parallel = true; }, /unsupported field/],
  ['unknown resource field', graph => { graph.resources[0].sql_id = 123; }, /unsupported field/],
  ['missing consumed resource', graph => { graph.operations[0].consumes = ['missing']; }, /does not exist/],
  ['missing output resource', graph => { graph.operations[0].produces = ['missing']; }, /does not exist/],
  ['duplicate consumed reference', graph => { graph.operations[0].consumes.push('carrots'); }, /duplicate resource/],
  ['duplicate output reference', graph => { graph.operations[0].produces.push('washed'); }, /duplicate resource/],
  ['ingredient output', graph => { graph.operations[0].produces.push('carrots'); }, /starting resources/],
  ['duplicate producer', graph => { graph.operations[1].produces.push('washed'); }, /more than one producer/],
  ['missing producer', graph => { graph.resources.push(component('orphan')); }, /needs an operation/],
  ['double-consumed ingredient', graph => { graph.operations[1].consumes.push('carrots'); }, /consumed more than once/],
  ['double-consumed component', graph => { graph.operations[2].consumes.push('washed'); }, /consumed more than once/],
  ['own output input', graph => { graph.operations[0].consumes.push('washed'); }, /own output/],
  ['material prerequisite', graph => { graph.operations[1].requires = ['carrots']; }, /belong under Consumes/],
  ['no operation outputs', graph => { graph.operations[0].produces = []; }, /Operation outputs/],
  ['null consumed list', graph => { graph.operations[0].consumes = null; }, /Consumed ingredients/],
  ['equipment string', graph => { graph.operations[0].equipment = 'knife'; }, /Equipment must be a list/],
  ['null equipment list', graph => { graph.operations[0].equipment = null; }, /Equipment must be a list/],
  ['duplicate equipment', graph => { graph.operations[0].equipment = ['Knife', 'knife']; }, /duplicate item/],
  ['negative source index', graph => { graph.resources[0].source_index = -1; }, /source position/],
  ['fractional source index', graph => { graph.resources[0].source_index = 0.5; }, /source position/],
  ['component source index', graph => { graph.resources[1].source_index = 0; }, /Only ingredients/],
  ['duplicate source index', graph => { graph.resources.push({ id: 'second-carrot', kind: 'ingredient', name: 'Carrot', source_index: 0 }); }, /source can appear only once/],
  ['unsupported schema', graph => { graph.schema_version = 2; }, /version is not supported/],
];
for (const [name, mutate, message] of invalidChanges) {
  test(`validation rejects ${name}`, () => {
    const graph = copy(sequential.pipeline);
    mutate(graph);
    assert.throws(() => validatePipeline(graph), message);
  });
}

test('readiness cannot be consumed and readiness prerequisites must exist', () => {
  const consumed = copy(bananaBread.pipeline);
  consumed.operations.find(entry => entry.id === 'bake').consumes.push('oven-ready');
  assert.throws(() => validatePipeline(consumed), /Required preparation/);
  const missing = copy(bananaBread.pipeline);
  missing.operations.find(entry => entry.id === 'bake').requires = ['missing'];
  assert.throws(() => validatePipeline(missing), /does not exist/);
  const duplicate = copy(bananaBread.pipeline);
  duplicate.operations.find(entry => entry.id === 'bake').requires.push('oven-ready');
  assert.throws(() => validatePipeline(duplicate), /duplicate resource/);
});

test('material and readiness cycles are rejected without hanging', () => {
  const material = {
    schema_version: 1, resources: [component('a'), component('b')],
    operations: [operation('one', ['b'], ['a']), operation('two', ['a'], ['b'])],
  };
  assert.throws(() => derivePipeline(material), /form a loop/);
  const requirements = {
    schema_version: 1, resources: [readiness('a'), readiness('b')],
    operations: [operation('one', [], ['a'], { requires: ['b'] }), operation('two', [], ['b'], { requires: ['a'] })],
  };
  assert.throws(() => validatePipeline(requirements), /form a loop/);
});

test('duration ranges and temperatures require finite, typed, bounded values', () => {
  for (const duration of [
    { min_seconds: -1, max_seconds: 30 }, { min_seconds: 30, max_seconds: 20 },
    { min_seconds: NaN, max_seconds: 30 }, { min_seconds: 0, max_seconds: Infinity },
    { min_seconds: '10', max_seconds: 20 }, { min_seconds: 10 },
    { min_seconds: 0, max_seconds: 31536001 }, { min_seconds: 0, max_seconds: 1, unit: 'minutes' }, [],
  ]) {
    const pipeline = copy(sequential.pipeline);
    pipeline.operations[0].duration = duration;
    assert.throws(() => validatePipeline(pipeline), /Duration|duration/);
  }
  for (const temperature of [
    { value: Infinity, unit: 'C' }, { value: NaN, unit: 'F' }, { value: '350', unit: 'F' },
    { value: -274, unit: 'C' }, { value: 4000, unit: 'F' }, { value: 200, unit: 'K' },
    { value: 200, unit: 'C', estimated: true }, [],
  ]) {
    const pipeline = copy(sequential.pipeline);
    pipeline.operations[0].temperature = temperature;
    assert.throws(() => validatePipeline(pipeline), /Temperature/);
  }
  const valid = copy(sequential.pipeline);
  valid.operations[0].duration = { min_seconds: 0, max_seconds: 0.5 };
  valid.operations[0].temperature = { value: 37.5, unit: 'C' };
  assert.deepEqual(validatePipeline(valid).operations[0].duration, valid.operations[0].duration);
});

test('graph bounds allow 100 operations but reject more or excessive resources', () => {
  const pipeline = { schema_version: 1, resources: [], operations: [] };
  for (let index = 0; index < 100; index++) {
    pipeline.resources.push(component(`result-${index}`));
    pipeline.operations.push(operation(`action-${index}`, index ? [`result-${index - 1}`] : [], [`result-${index}`]));
  }
  assert.equal(derivePipeline(pipeline).layers.length, 100);
  pipeline.operations.push(operation('too-many', [], ['result-0']));
  assert.throws(() => validatePipeline(pipeline), /1 to 100 operations/);
  const excessiveResources = copy(sequential.pipeline);
  excessiveResources.resources = Array.from({ length: 301 }, (_, index) => component(`result-${index}`));
  assert.throws(() => validatePipeline(excessiveResources), /1 to 300 resources/);
});

test('non-object documents and empty saved graphs are invalid', () => {
  for (const value of [null, undefined, [], '', 1, new Date()]) assert.throws(() => validatePipeline(value), /must be an object/);
  assert.throws(() => validatePipeline({ schema_version: 1, resources: [], operations: [] }), /resources/);
  assert.throws(() => validatePipeline({ schema_version: 1, resources: [component('dish')], operations: [] }), /operations/);
});

test('drafts preserve each ingredient occurrence and never infer actions from prose', () => {
  const recipe = {
    notes: 'Preheat oven to 350°F. Mash bananas. Melt butter in parallel. Bake 60 minutes.',
    ingredients: [{ id: 91, name: ' Butter ', quantity: '  10 g ' }, { id: 93, name: 'Butter', quantity: '80 g' }],
  };
  const draft = createPipelineDraft(recipe);
  assert.deepEqual(draft, {
    schema_version: 1,
    resources: [
      { id: 'ingredient-1', kind: 'ingredient', name: 'Butter', quantity: '10 g', source_index: 0 },
      { id: 'ingredient-2', kind: 'ingredient', name: 'Butter', quantity: '80 g', source_index: 1 },
    ],
    operations: [],
  });
  assert.throws(() => validatePipeline(draft), /operations/);
  assert.deepEqual(createPipelineDraft({ ingredients: recipe.ingredients, notes: 'Completely different prose.' }), draft);
  assert.equal(recipe.ingredients[0].name, ' Butter ');
});

test('drafts work without written instructions and enforce resource limits without truncation', () => {
  assert.deepEqual(createPipelineDraft({}), { schema_version: 1, resources: [], operations: [] });
  assert.equal(createPipelineDraft({ ingredients: [{ name: 'Water', quantity: null }] }).resources[0].quantity, '');
  assert.throws(() => createPipelineDraft({ ingredients: [{ name: '' }] }), /Resource name/);
  assert.throws(() => createPipelineDraft({ ingredients: Array.from({ length: 301 }, () => ({ name: 'Water' })) }), /at most 300 resources/);
});

test('source identity ignores mutable SQL IDs and metadata while retaining recipe content and occurrence order', () => {
  const recipe = { title: 'Original', notes: '  Mix.\r\nBake.  ', ingredients: [{ id: 1, name: ' Red   onion ', quantity: ' 2 ' }] };
  const equivalent = { title: 'Renamed', notes: 'Mix.\nBake.', ingredients: [{ id: 999, name: 'Red onion', quantity: '2', category: 'Produce' }] };
  assert.equal(pipelineSource(recipe), pipelineSource(equivalent));
  assert.deepEqual(JSON.parse(pipelineSource(recipe)), { notes: 'Mix.\nBake.', ingredients: [{ name: 'Red onion', quantity: '2' }] });
  assert.notEqual(pipelineSource(recipe), pipelineSource({ ...recipe, notes: 'Boil.' }));
  assert.notEqual(pipelineSource(recipe), pipelineSource({ ...recipe, ingredients: [{ name: 'Red onion', quantity: '3' }] }));
  assert.notEqual(pipelineSource({ ingredients: [{ name: 'A' }, { name: 'B' }] }), pipelineSource({ ingredients: [{ name: 'B' }, { name: 'A' }] }));
});

test('source hashing remains available for legacy recipes outside graph limits', () => {
  const recipe = { notes: '', ingredients: Array.from({ length: 301 }, (_, index) => ({ name: `Ingredient ${index}`, quantity: null })) };
  assert.equal(JSON.parse(pipelineSource(recipe)).ingredients.length, 301);
  assert.deepEqual(JSON.parse(pipelineSource(null)), { notes: '', ingredients: [] });
});
