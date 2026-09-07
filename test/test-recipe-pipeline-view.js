import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPipelineGraph, mountPipelineGraph, routePipelineDependency } from '../public/components/recipe-pipeline-view.js';

const resource = (id, kind, name, quantity = '') => ({ id, kind, name, quantity });
const operation = (id, label, consumes, produces, extra = {}) => ({ id, label, consumes, produces, ...extra });

function bananaBread() {
  return {
    schema_version: 1,
    resources: [
      resource('bananas', 'ingredient', 'bananas', '2 ripe'),
      resource('flour', 'ingredient', 'flour', '200 g'),
      resource('walnuts', 'ingredient', 'walnuts', '50 g'),
      resource('mashed', 'component', 'Mashed bananas'),
      resource('dry', 'component', 'Dry mixture'),
      resource('batter', 'component', 'Banana batter'),
      resource('oven', 'readiness', 'Oven at 350°F'),
      resource('bread', 'component', 'Baked bread'),
      resource('cooled', 'component', 'Cooled loaf'),
    ],
    // Authored order is deliberately different from dependency order.
    operations: [
      operation('bake', 'Bake the loaf', ['batter'], ['bread'], { requires: ['oven'], equipment: ['Loaf pan'], duration: { min_seconds: 3300, max_seconds: 3600 }, temperature: { value: 350, unit: 'F' } }),
      operation('preheat', 'Preheat oven', [], ['oven'], { equipment: ['Oven'] }),
      operation('mash', 'Mash bananas', ['bananas'], ['mashed']),
      operation('whisk', 'Whisk dry ingredients', ['flour'], ['dry']),
      operation('combine', 'Fold together', ['mashed', 'dry'], ['batter']),
      operation('cool', 'Cool on a rack', ['bread'], ['cooled'], { duration: { min_seconds: 600, max_seconds: 600 }, equipment: ['Cooling rack'] }),
    ],
  };
}

function article(html, label) {
  return html.match(new RegExp(`<article\\b[^>]*>[\\s\\S]*?<h4[^>]*>${label}</h4>[\\s\\S]*?</article>`))?.[0].split('<article').at(-1);
}

test('resource flow places parallel preparation before convergence and the oven before baking', () => {
  const html = renderPipelineGraph(bananaBread());
  assert.equal((html.match(/class="recipe-pipeline-stage"/g) || []).length, 4);
  assert.ok(html.indexOf('Preheat oven</h4>') < html.indexOf('Fold together</h4>'));
  assert.ok(html.indexOf('Fold together</h4>') < html.indexOf('Bake the loaf</h4>'));
  assert.match(html, /Parallel options/);
  assert.match(article(html, 'Fold together'), /Bring together/);
  assert.match(article(html, 'Fold together'), /From 2\. Mash bananas/);
  assert.match(article(html, 'Fold together'), /From 3\. Whisk dry ingredients/);
  assert.match(article(html, 'Bake the loaf'), /Needs ready/);
  assert.match(article(html, 'Bake the loaf'), /From 1\. Preheat oven/);
  assert.match(html, /Stages show dependencies, not a cooking schedule/);
});

test('ingredients appear with their first consuming step, with unused ingredients kept visible', () => {
  const html = renderPipelineGraph(bananaBread());
  assert.equal((html.match(/2 ripe bananas/g) || []).length, 1);
  assert.equal((html.match(/200 g flour/g) || []).length, 1);
  assert.match(article(html, 'Mash bananas'), /2 ripe bananas/);
  assert.match(article(html, 'Mash bananas'), /Makes[\s\S]*Mashed bananas/);
  assert.match(article(html, 'Fold together'), /Uses[\s\S]*Mashed bananas/);
  assert.match(html, /Ingredients not used in this map[\s\S]*50 g walnuts/);
});

test('specified duration ranges, temperatures, and equipment are visible without fabricating unknown times', () => {
  const html = renderPipelineGraph(bananaBread());
  assert.match(article(html, 'Bake the loaf'), /55 min–1 hr/);
  assert.match(article(html, 'Bake the loaf'), /350 °F/);
  assert.match(article(html, 'Bake the loaf'), /Equipment:<\/span> Loaf pan/);
  assert.match(article(html, 'Cool on a rack'), /10 min/);
  assert.doesNotMatch(article(html, 'Mash bananas'), /recipe-pipeline-metadata/);
  assert.doesNotMatch(html, /\b0 (?:min|sec)/);
});

test('operation, resource, quantity, and equipment text cannot become markup or attributes', () => {
  const document = {
    schema_version: 1,
    resources: [resource('raw', 'ingredient', '<img src=x onerror=alert(1)>', '"2 & 3"'), resource('ready', 'component', '<script>bad</script>')],
    operations: [operation('mix', 'Mix "wet" <b>stuff</b>', ['raw'], ['ready'], { equipment: ['<svg onload=bad>'] })],
  };
  const html = renderPipelineGraph(document, { editable: true });
  assert.doesNotMatch(html, /<img|<script>|<b>|<svg onload/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;2 &amp; 3&quot;/);
  assert.match(html, /aria-label="Edit Mix &quot;wet&quot; &lt;b&gt;stuff&lt;\/b&gt;"/);
});

test('read-only cards have no editing controls and an absent map has a helpful empty state', () => {
  assert.doesNotMatch(renderPipelineGraph(bananaBread()), /data-pipeline-edit=/);
  assert.match(renderPipelineGraph(bananaBread(), { editable: true }), /data-pipeline-edit="bake"/);
  assert.match(renderPipelineGraph(null), /No cooking map yet/);
  assert.match(renderPipelineGraph({ operations: [] }), /Add the ingredients/);
});

test('invalid authored resource links are rejected instead of silently drawing an invented order', () => {
  const document = bananaBread();
  document.operations[0].consumes = ['missing'];
  assert.throws(() => renderPipelineGraph(document));
});

function segmentCrosses(a, b, rectangle) {
  if (a.x === b.x) return a.x > rectangle.left && a.x < rectangle.right && Math.max(a.y, b.y) > rectangle.top && Math.min(a.y, b.y) < rectangle.bottom;
  return a.y > rectangle.top && a.y < rectangle.bottom && Math.max(a.x, b.x) > rectangle.left && Math.min(a.x, b.x) < rectangle.right;
}

test('arrows connect exact card edges and route through gutters around skipped stages and wrapped rows', () => {
  const source = { left: 20, right: 140, top: 30, bottom: 80 };
  const target = { left: 20, right: 140, top: 300, bottom: 380 };
  const obstacle = { left: 20, right: 140, top: 120, bottom: 230 };
  const rectangles = [source, obstacle, target];
  const path = routePipelineDependency(source, target, rectangles, 320);
  assert.deepEqual(path[0], { x: 80, y: 80 });
  assert.deepEqual(path.at(-1), { x: 80, y: 300 });
  assert.ok(path.some(point => point.x < source.left));
  for (let i = 1; i < path.length; i++) {
    for (const rectangle of rectangles) assert.equal(segmentCrosses(path[i - 1], path[i], rectangle), false);
  }
  assert.ok(path.every(point => point.x >= 0 && point.x <= 320));
});

test('adjacent independent branches keep direct dependency connectors inside the board', () => {
  const source = { left: 20, right: 140, top: 0, bottom: 80 };
  const target = { left: 170, right: 290, top: 180, bottom: 260 };
  const path = routePipelineDependency(source, target, [source, target], 320);
  assert.equal(path.length, 4);
  assert.deepEqual(path.at(-1), { x: 230, y: 180 });
});

function mountHarness() {
  let width = 0;
  let observed = [];
  let disconnected = false;
  let resizeCallback;
  let frameId = 0;
  const frames = new Map();
  const windowListeners = new Map();
  const containerListeners = new Map();
  const pathGroup = { innerHTML: '' };
  const svg = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, querySelector: () => pathGroup };
  const cards = [
    { getBoundingClientRect: () => ({ left: 30, right: 250, top: 60, bottom: 160 }) },
    { getBoundingClientRect: () => ({ left: 30, right: 250, top: 280, bottom: 400 }) },
  ];
  const board = {
    querySelector: () => svg,
    querySelectorAll: () => cards,
    getBoundingClientRect: () => ({ left: 10, top: 20, width, height: width ? 400 : 0 }),
  };
  const view = {
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener: (type, handler) => windowListeners.set(type, handler),
    removeEventListener: type => windowListeners.delete(type),
    ResizeObserver: class {
      constructor(callback) { resizeCallback = callback; }
      observe(element) { observed.push(element); }
      disconnect() { disconnected = true; }
    },
  };
  const container = {
    innerHTML: '', ownerDocument: { defaultView: view }, querySelector: () => board,
    addEventListener: (type, handler) => containerListeners.set(type, handler),
    removeEventListener: type => containerListeners.delete(type),
    contains: node => node?.inside === true,
  };
  return {
    container, svg, pathGroup, frames, windowListeners, containerListeners,
    setWidth(value) { width = value; resizeCallback(); },
    flush() { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } },
    get observed() { return observed; },
    get disconnected() { return disconnected; },
  };
}

function dualConnection() {
  return {
    schema_version: 1,
    resources: [resource('pan', 'component', 'Prepared pan'), resource('oven', 'readiness', 'Hot oven'), resource('done', 'component', 'Finished bake')],
    operations: [operation('prepare', 'Prepare pan and oven', [], ['pan', 'oven']), operation('bake', 'Bake', ['pan'], ['done'], { requires: ['oven'] })],
  };
}

test('hidden maps redraw when revealed, with distinct material and readiness paths between the same cards', () => {
  const harness = mountHarness();
  const cleanup = mountPipelineGraph(harness.container, dualConnection());
  harness.flush();
  assert.equal(harness.pathGroup.innerHTML, '');
  harness.setWidth(280);
  harness.flush();
  assert.equal(harness.svg.attributes.viewBox, '0 0 280 400');
  assert.equal((harness.pathGroup.innerHTML.match(/<path /g) || []).length, 2);
  assert.match(harness.pathGroup.innerHTML, /recipe-pipeline-edge--readiness/);
  const paths = [...harness.pathGroup.innerHTML.matchAll(/ d="([^"]+)"/g)].map(match => match[1]);
  assert.notEqual(paths[0], paths[1]);
  assert.equal(harness.observed.length, 3);
  cleanup();
});

test('edit calls the provided operation ID, and cleanup removes observers, listeners, and queued frames', () => {
  const harness = mountHarness();
  const edits = [];
  const cleanup = mountPipelineGraph(harness.container, dualConnection(), { onEdit: id => edits.push(id) });
  harness.containerListeners.get('click')({ target: { closest: () => ({ inside: true, dataset: { pipelineEdit: 'bake' } }) } });
  harness.containerListeners.get('click')({ target: { closest: () => ({ inside: true, dataset: { pipelineEdit: 'missing' } }) } });
  assert.deepEqual(edits, ['bake']);
  assert.equal(harness.frames.size, 1);
  cleanup();
  assert.equal(harness.disconnected, true);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.windowListeners.size, 0);
  assert.equal(harness.containerListeners.size, 0);
  harness.setWidth(280);
  assert.equal(harness.frames.size, 0);
});
