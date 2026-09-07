import { derivePipeline } from '../utils/recipe-pipeline.js';

let graphSequence = 0;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function resourceLabel(resource) {
  return [resource.quantity, resource.name].filter(value => value != null && String(value).trim()).join(' ');
}

function formatSeconds(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Number((seconds % 60).toFixed(2));
  return [hours ? `${hours} hr` : '', minutes ? `${minutes} min` : '', rest ? `${rest} sec` : ''].filter(Boolean).join(' ') || '0 sec';
}

function formatDuration(duration) {
  if (!duration) return '';
  const minimum = formatSeconds(duration.min_seconds);
  return duration.min_seconds === duration.max_seconds ? minimum : `${minimum}–${formatSeconds(duration.max_seconds)}`;
}

function graphMarkup(derived, { idPrefix, editable = false }) {
  const { pipeline, layers, order, edges, unusedIngredients } = derived;
  const indexes = new Map(order.map((operation, index) => [operation.id, index]));
  const operations = new Map(order.map(operation => [operation.id, operation]));
  const resources = new Map(pipeline.resources.map(resource => [resource.id, resource]));
  const producers = new Map();
  for (const operation of order) for (const resource of operation.produces) producers.set(resource, operation);
  const safePrefix = escapeHtml(idPrefix);

  function sourceLabel(resourceId) {
    const producer = producers.get(resourceId);
    return producer ? `<span class="recipe-pipeline-resource-source">From ${indexes.get(producer.id) + 1}. ${escapeHtml(producer.label)}</span>` : '';
  }

  function resourceList(ids, { source = false, readiness = false } = {}) {
    return `<ul>${ids.map(id => {
      const resource = resources.get(id);
      return `<li${readiness ? ' class="recipe-pipeline-readiness-resource"' : ''}><span>${escapeHtml(resourceLabel(resource))}</span>${source ? sourceLabel(id) : ''}</li>`;
    }).join('')}</ul>`;
  }

  const stages = layers.map((layer, layerIndex) => `
    <section class="recipe-pipeline-stage" aria-labelledby="${safePrefix}-stage-${layerIndex}">
      <h3 class="recipe-pipeline-stage-heading" id="${safePrefix}-stage-${layerIndex}"><span>Stage ${layerIndex + 1}</span>${layer.length > 1 ? '<span class="recipe-pipeline-parallel-label">Parallel options</span>' : ''}</h3>
      <div class="recipe-pipeline-stage-cards">${layer.map(operation => {
        const index = indexes.get(operation.id);
        const incoming = edges.filter(edge => edge.to === operation.id);
        const dependencies = [...new Set(incoming.map(edge => edge.from))];
        const materialParents = new Set(incoming.filter(edge => edge.kind === 'consumes').map(edge => edge.from));
        const materialOutputs = operation.produces.filter(id => resources.get(id).kind !== 'readiness');
        const readinessOutputs = operation.produces.filter(id => resources.get(id).kind === 'readiness');
        const metadata = [formatDuration(operation.duration), operation.temperature ? `${operation.temperature.value} °${operation.temperature.unit}` : ''].filter(Boolean);
        return `<article class="recipe-pipeline-step${materialParents.size > 1 ? ' recipe-pipeline-step--merge' : ''}" data-pipeline-step-index="${index}" aria-labelledby="${safePrefix}-step-${index}">
          <div class="recipe-pipeline-step-heading"><span class="recipe-pipeline-step-number" aria-hidden="true">${index + 1}</span><h4 id="${safePrefix}-step-${index}">${escapeHtml(operation.label)}</h4>${editable ? `<button type="button" class="recipe-pipeline-edit" data-pipeline-edit="${escapeHtml(operation.id)}" aria-label="Edit ${escapeHtml(operation.label)}">Edit</button>` : ''}</div>
          ${materialParents.size > 1 ? '<p class="recipe-pipeline-merge-label">Bring together</p>' : ''}
          ${metadata.length ? `<p class="recipe-pipeline-metadata">${metadata.map(value => `<span>${escapeHtml(value)}</span>`).join('')}</p>` : ''}
          ${operation.equipment.length ? `<p class="recipe-pipeline-equipment"><span>Equipment:</span> ${operation.equipment.map(escapeHtml).join(', ')}</p>` : ''}
          ${operation.consumes.length ? `<div class="recipe-pipeline-inputs"><p class="recipe-pipeline-resource-heading">Uses</p>${resourceList(operation.consumes, { source: true })}</div>` : ''}
          ${operation.requires.length ? `<div class="recipe-pipeline-requires"><p class="recipe-pipeline-resource-heading">Needs ready</p>${resourceList(operation.requires, { source: true, readiness: true })}</div>` : ''}
          ${materialOutputs.length ? `<div class="recipe-pipeline-outputs"><p class="recipe-pipeline-resource-heading">Makes</p>${resourceList(materialOutputs)}</div>` : ''}
          ${readinessOutputs.length ? `<div class="recipe-pipeline-outputs recipe-pipeline-outputs--readiness"><p class="recipe-pipeline-resource-heading">Makes ready</p>${resourceList(readinessOutputs, { readiness: true })}</div>` : ''}
          <div class="recipe-pipeline-prerequisites">${dependencies.length ? `<p>After:</p><ul>${dependencies.map(id => `<li><span class="recipe-pipeline-reference">${indexes.get(id) + 1}.</span> ${escapeHtml(operations.get(id).label)}</li>`).join('')}</ul>` : '<p>No earlier step required</p>'}</div>
        </article>`;
      }).join('')}</div>
    </section>`).join('');

  return `<div class="recipe-pipeline-graph">
    <p class="recipe-pipeline-guide">Stages show dependencies, not a cooking schedule. Parallel options have no dependency on one another. Check shared equipment before starting; only specified times are shown.</p>
    <div class="recipe-pipeline-legend"><span><i class="recipe-pipeline-legend-line" aria-hidden="true"></i>Ingredient or component flow</span><span><i class="recipe-pipeline-legend-line recipe-pipeline-legend-line--readiness" aria-hidden="true"></i>Readiness requirement</span></div>
    <div class="recipe-pipeline-board">
      <svg class="recipe-pipeline-connections" aria-hidden="true" focusable="false"><defs><marker id="${safePrefix}-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 7 3.5 L 0 7 z"></path></marker></defs><g data-pipeline-paths></g></svg>
      ${stages}
    </div>
    ${unusedIngredients.length ? `<aside class="recipe-pipeline-unassigned"><h3>Ingredients not used in this map</h3>${resourceList(unusedIngredients.map(resource => resource.id))}</aside>` : ''}
  </div>`;
}

/** Accessible cards remain useful without SVG, JavaScript, or color perception. */
export function renderPipelineGraph(document, { idPrefix = `recipe-pipeline-${++graphSequence}`, editable = false } = {}) {
  if (!document?.operations?.length) return '<p class="recipe-pipeline-empty">No cooking map yet. Add the ingredients, preparation steps, and what each step makes.</p>';
  return graphMarkup(derivePipeline(document), { idPrefix, editable });
}

function crossesCard(a, b, rectangle) {
  // Touching a card edge is intentional; crossing its interior is not.
  const epsilon = 0.5;
  if (a.x === b.x) return a.x > rectangle.left + epsilon && a.x < rectangle.right - epsilon
    && Math.max(a.y, b.y) > rectangle.top + epsilon && Math.min(a.y, b.y) < rectangle.bottom - epsilon;
  return a.y > rectangle.top + epsilon && a.y < rectangle.bottom - epsilon
    && Math.max(a.x, b.x) > rectangle.left + epsilon && Math.min(a.x, b.x) < rectangle.right - epsilon;
}

/** Route around card interiors, including wrapped rows and skipped stages. */
export function routePipelineDependency(source, target, rectangles, width, laneIndex = 0, portOffset = 0) {
  const start = { x: (source.left + source.right) / 2 + portOffset, y: source.bottom };
  const end = { x: (target.left + target.right) / 2 + portOffset, y: target.top };
  const middle = (start.y + end.y) / 2;
  const direct = [start, { x: start.x, y: middle }, { x: end.x, y: middle }, end];
  const obstructed = direct.slice(1).some((point, index) => rectangles.some(rectangle => crossesCard(direct[index], point, rectangle)));
  if (!obstructed) return direct;
  const inset = 4 + (laneIndex % 3) * 4;
  const laneX = start.x + end.x < width ? inset : width - inset;
  return [start, { x: start.x, y: start.y + 12 }, { x: laneX, y: start.y + 12 },
    { x: laneX, y: end.y - 12 }, { x: end.x, y: end.y - 12 }, end];
}

/** Mount cards and arrows; callers must dispose before replacing their surface. */
export function mountPipelineGraph(container, document, { onEdit } = {}) {
  if (!document?.operations?.length) {
    container.innerHTML = renderPipelineGraph(document);
    return () => {};
  }
  const derived = derivePipeline(document);
  const idPrefix = `recipe-pipeline-${++graphSequence}`;
  container.innerHTML = graphMarkup(derived, { idPrefix, editable: typeof onEdit === 'function' });
  const board = container.querySelector('.recipe-pipeline-board');
  const svg = board.querySelector('svg');
  const pathGroup = svg.querySelector('[data-pipeline-paths]');
  const cards = [...board.querySelectorAll('[data-pipeline-step-index]')];
  const indexes = new Map(derived.order.map((operation, index) => [operation.id, index]));
  // Several resources may connect the same operations. One line per type
  // avoids overpainting; each card still names every individual resource.
  const connections = new Map();
  for (const edge of derived.edges) connections.set(`${edge.from}/${edge.to}/${edge.kind}`, edge);
  const view = container.ownerDocument?.defaultView || globalThis;
  const requestFrame = view.requestAnimationFrame?.bind(view) || (fn => setTimeout(fn, 0));
  const cancelFrame = view.cancelAnimationFrame?.bind(view) || clearTimeout;
  let pendingFrame = null;
  let disposed = false;
  function draw() {
    pendingFrame = null;
    if (disposed) return;
    const bounds = board.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const rectangles = cards.map(card => {
      const rectangle = card.getBoundingClientRect();
      return { left: rectangle.left - bounds.left, right: rectangle.right - bounds.left,
        top: rectangle.top - bounds.top, bottom: rectangle.bottom - bounds.top };
    });
    svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
    pathGroup.innerHTML = [...connections.values()].map((edge, index) => {
      const otherType = connections.has(`${edge.from}/${edge.to}/${edge.kind === 'requires' ? 'consumes' : 'requires'}`);
      const offset = otherType ? (edge.kind === 'requires' ? 4 : -4) : 0;
      const points = routePipelineDependency(rectangles[indexes.get(edge.from)], rectangles[indexes.get(edge.to)], rectangles, bounds.width, index, offset);
      return `<path class="recipe-pipeline-edge${edge.kind === 'requires' ? ' recipe-pipeline-edge--readiness' : ''}" d="${points.map((point, part) => `${part ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')}" marker-end="url(#${idPrefix}-arrow)"></path>`;
    }).join('');
  }
  function scheduleDraw() {
    if (!disposed && pendingFrame == null) pendingFrame = requestFrame(draw);
  }
  function editOperation(event) {
    const button = event.target.closest?.('[data-pipeline-edit]');
    if (button && container.contains(button) && indexes.has(button.dataset.pipelineEdit)) onEdit?.(button.dataset.pipelineEdit);
  }
  const Observer = view.ResizeObserver || globalThis.ResizeObserver;
  const observer = Observer ? new Observer(scheduleDraw) : null;
  observer?.observe(board);
  cards.forEach(card => observer?.observe(card));
  view.addEventListener?.('resize', scheduleDraw);
  container.addEventListener('click', editOperation);
  container.ownerDocument?.fonts?.ready?.then(scheduleDraw);
  scheduleDraw();
  return () => {
    disposed = true;
    observer?.disconnect();
    view.removeEventListener?.('resize', scheduleDraw);
    container.removeEventListener('click', editOperation);
    if (pendingFrame != null) cancelFrame(pendingFrame);
  };
}
