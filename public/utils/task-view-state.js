// View-only reconciliation. API snapshots remain the source of Task data.
const markup = new WeakMap();
const scopes = new WeakMap();

function key(node) {
  if (node.nodeType !== 1) return null;
  for (const name of ['data-view-key', 'data-swipe-id', 'data-subtask-id', 'data-board-section', 'data-task-calendar-date', 'id']) {
    if (node.hasAttribute(name)) return node.tagName + ':' + name + ':' + node.getAttribute(name);
  }
  if (node.matches('article[data-task-id]')) return 'task:' + node.dataset.taskId;
  for (const name of ['data-bucket-key', 'data-group-toggle', 'data-drop-zone', 'data-action', 'data-focus-key']) {
    if (node.hasAttribute(name)) return node.tagName + ':' + name + ':' + node.getAttribute(name) + ':' + (node.dataset.id || node.dataset.userId || '');
  }
  return null;
}
const compatible = (a, b) => a?.nodeType === b.nodeType && a?.nodeName === b.nodeName;

function syncNode(current, next) {
  const signature = next.nodeType === 1 ? next.outerHTML : next.nodeValue;
  if (markup.get(current) === signature) return;
  if (next.nodeType !== 1) current.nodeValue = next.nodeValue;
  else {
    for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    for (const attr of next.attributes) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    // Attributes alone do not update a checkbox after the user has changed it.
    if (next.tagName === 'INPUT') current.checked = next.checked;
    syncChildren(current, next);
  }
  markup.set(current, signature);
}

function syncChildren(parent, nextParent) {
  const keyed = new Map([...parent.childNodes].map(node => [key(node), node]).filter(([id]) => id));
  let cursor = parent.firstChild;
  for (const next of [...nextParent.childNodes]) {
    const id = key(next);
    let current = id ? keyed.get(id) : (!key(cursor || {}) && compatible(cursor, next) ? cursor : null);
    if (!compatible(current, next)) current = next.cloneNode(false);
    if (current !== cursor) parent.insertBefore(current, cursor);
    syncNode(current, next);
    cursor = current.nextSibling;
  }
  while (cursor) { const removed = cursor; cursor = cursor.nextSibling; removed.remove(); }
}

function visible(node) {
  return !!node?.isConnected && !node.closest('[hidden]') && node.getClientRects().length > 0;
}
function focusIdentity(root, element) {
  if (!root.contains(element)) return null;
  const card = element.closest('article[data-task-id]');
  const scope = card || element.closest('[data-view-key], [data-bucket-key], [data-board-section]') || root;
  return { element, scopeKey: key(scope), scope, action: key(element) };
}
function findFocus(root, saved) {
  if (visible(saved.element) && !saved.element.disabled) return saved.element;
  if (!saved.action) return null;
  const scope = saved.scopeKey
    ? [...root.querySelectorAll('[data-view-key], [data-bucket-key], [data-board-section], article[data-task-id]')].find(node => key(node) === saved.scopeKey)
    : root;
  const found = scope && [...scope.querySelectorAll('button, input, select, textarea, [tabindex]')].find(node => key(node) === saved.action);
  return visible(found) && !found.disabled ? found : null;
}

/** Capture at paint time so a user who scrolled during a request keeps that position. */
export function captureTaskViewport(root, { anchors = true } = {}) {
  const doc = root.ownerDocument;
  const clips = new WeakMap();
  function intersectsViewport(node, port, rect, box) {
    let { top, left, bottom, right } = rect;
    // A previous Kanban column can geometrically overlap the page's padding
    // while being completely clipped by the board. Only anchor content the
    // reader can actually see through all intervening scrollports.
    for (let parent = node.parentElement; parent && parent !== port; parent = parent.parentElement) {
      let clip = clips.get(parent);
      if (!clip) {
        const style = doc.defaultView.getComputedStyle(parent);
        clip = { rect: parent.getBoundingClientRect(), x: /auto|scroll|hidden|clip/.test(style.overflowX), y: /auto|scroll|hidden|clip/.test(style.overflowY) };
        clips.set(parent, clip);
      }
      if (clip.x) { left = Math.max(left, clip.rect.left); right = Math.min(right, clip.rect.right); }
      if (clip.y) { top = Math.max(top, clip.rect.top); bottom = Math.min(bottom, clip.rect.bottom); }
    }
    return right > left && bottom > top && box.bottom > top && box.top < bottom && box.right > left && box.left < right;
  }
  const ports = new Set(root.querySelectorAll('.task-board, .task-board__bucket-scroll'));
  for (let node = root; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth) ports.add(node);
  }
  if (doc.scrollingElement) ports.add(doc.scrollingElement);
  const positions = [...ports].map(port => {
    const rect = port === doc.scrollingElement ? { top: 0, left: 0, bottom: doc.defaultView.innerHeight, right: doc.defaultView.innerWidth } : port.getBoundingClientRect();
    const candidates = anchors ? [...root.querySelectorAll('article[data-task-id], [data-view-key], [data-board-section]')].filter(node => {
      if (node === port || !port.contains(node) || !visible(node)) return false;
      // Page scrolling anchors buckets, not the offscreen cards inside an independently scrolled bucket.
      const nested = node.closest('.task-board__bucket-scroll');
      if (nested && nested !== port && nested.scrollHeight > nested.clientHeight) return false;
      const box = node.getBoundingClientRect();
      return intersectsViewport(node, port, rect, box)
        && (node.matches('article[data-task-id]') || box.top >= rect.top - 1);
    }).slice(0, 12).map(node => ({ node, top: node.getBoundingClientRect().top - rect.top, left: node.getBoundingClientRect().left - rect.left })) : [];
    return { port, top: port.scrollTop, left: port.scrollLeft, candidates };
  });
  const focused = focusIdentity(root, doc.activeElement);
  return () => {
    // Restore synchronously, before paint. Do not queue an old restoration that
    // could overrule a later user scroll, filter change or newly opened dialog.
    for (const saved of positions) {
      const { port } = saved;
      if (!port.isConnected) continue;
      // Assigning even the current offset can stop native touch momentum.
      if (Math.abs(port.scrollLeft - saved.left) > 0.5) port.scrollLeft = saved.left;
      if (Math.abs(port.scrollTop - saved.top) > 0.5) port.scrollTop = saved.top;
      const anchor = saved.candidates.find(item => visible(item.node) && port.contains(item.node));
      if (anchor) {
        const top = port === doc.scrollingElement ? 0 : port.getBoundingClientRect().top;
        const delta = anchor.node.getBoundingClientRect().top - top - anchor.top;
        if (Math.abs(delta) > 0.5) port.scrollTop += delta;
        if (port.matches('.task-board')) {
          const deltaX = anchor.node.getBoundingClientRect().left - port.getBoundingClientRect().left - anchor.left;
          if (Math.abs(deltaX) > 0.5) port.scrollLeft += deltaX;
        }
      }
    }
    if (focused && (doc.activeElement === focused.element || doc.activeElement === doc.body || doc.activeElement === doc.documentElement)) {
      findFocus(root, focused)?.focus({ preventScroll: true });
    }
  };
}

/** Keep scrollports, unchanged cards and delegated-event targets alive. */
export function reconcileTaskMarkup(root, html, scope) {
  const sameScope = scopes.get(root) === scope;
  const restore = captureTaskViewport(root, { anchors: sameScope });
  const template = root.ownerDocument.createElement('template');
  template.innerHTML = html;
  syncChildren(root, template.content);
  scopes.set(root, scope);
  // New filters/layouts keep their selected controls, but never restore an old
  // card's viewport anchor or focus into a newly filtered result set.
  if (sameScope) restore();
  return sameScope;
}
