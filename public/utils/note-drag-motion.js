/** A visual-only lean: gentle at low speed, more pronounced during a brisk drag. */
export function advanceNoteDragTilt(previous, deltaX, elapsedMs) {
  const duration = Math.max(1, elapsedMs);
  const velocity = deltaX / duration, speed = Math.abs(velocity);
  const target = Math.sign(velocity) * Math.min(4, .75 * speed + 3.25 * speed * speed);
  return previous + (target - previous) * (1 - Math.exp(-duration / 60));
}

/** Visual copies only: the original, connected card remains the pointer owner. */
export function createNoteDragPreview(cards, { clientX, clientY, selectedIds, anchor = cards[0] } = {}) {
  if (!anchor || !cards.length) return null;
  const rect = anchor.getBoundingClientRect();
  const offset = { x: clientX - rect.left, y: clientY - rect.top };
  const layer = document.createElement('div');
  layer.className = 'note-group-drag-proxy notes-board';
  layer.dataset.groupDragProxy = '';
  layer.dataset.boardView = 'canvas';
  layer.dataset.selectedIds = JSON.stringify(selectedIds);
  layer.setAttribute('aria-hidden', 'true'); layer.inert = true;
  Object.assign(layer.style, { width: `${rect.width}px`, height: `${rect.height}px` });
  for (const name of ['--module-accent', '--note-group-ui-scale']) {
    layer.style.setProperty(name, getComputedStyle(anchor).getPropertyValue(name));
  }
  // A small stack communicates a large selection without duplicating hundreds
  // of rich bodies. The complete ordered selection remains on the gesture.
  cards.slice(0, 3).forEach((source, index) => {
    const copy = source.cloneNode(true), bounds = source.getBoundingClientRect();
    const width = source.offsetWidth || bounds.width, height = source.offsetHeight || bounds.height;
    const scale = bounds.width / width;
    for (const node of [copy, ...copy.querySelectorAll('*')]) {
      for (const attribute of [...node.attributes]) {
        if (attribute.name === 'id' || attribute.name.startsWith('data-')) node.removeAttribute(attribute.name);
      }
      if (node.matches('button,input,select,textarea')) node.disabled = true;
      if (node.matches('a,button,input,select,textarea,summary,[tabindex]')) node.tabIndex = -1;
    }
    copy.classList.remove('is-placeholder', 'note-card--drag-source', 'note-card--settling', 'note-card--resizing');
    copy.classList.add('note-card', 'note-card--moving');
    Object.assign(copy.style, { left: `${index * 8}px`, top: `${index * 8}px`, width: `${width}px`, height: `${height}px`,
      transform: `scale(${scale})`, transformOrigin: 'top left', zIndex: String(3 - index), opacity: '1' });
    const sourceBodies = source.querySelectorAll('.note-card__content');
    layer.append(copy);
    copy.querySelectorAll('.note-card__content').forEach((body, i) => { body.scrollTop = sourceBodies[i]?.scrollTop || 0; });
  });
  if (selectedIds.length > 1) {
    const count = document.createElement('span'); count.className = 'note-group-drag-proxy__count'; count.textContent = String(selectedIds.length); layer.append(count);
  }
  document.body.append(layer);
  // Scroll offsets can only be restored after the copies acquire layout.
  [...layer.querySelectorAll(':scope > .note-card')].forEach((copy, index) => {
    const originals = cards[index].querySelectorAll('.note-card__content');
    copy.querySelectorAll('.note-card__content').forEach((body, i) => { body.scrollTop = originals[i]?.scrollTop || 0; });
  });
  let x = clientX, y = clientY, paintedX = x, time = performance.now(), frame = 0, disposed = false;
  let tilt = parseFloat(anchor.style.getPropertyValue('--note-drag-tilt')) || 0;
  const move = point => {
    x = point.clientX; y = point.clientY;
    layer.style.left = `${x - offset.x}px`; layer.style.top = `${y - offset.y}px`;
  };
  const animate = now => {
    if (disposed) return;
    tilt = advanceNoteDragTilt(tilt, x - paintedX, now - time);
    for (const card of layer.querySelectorAll(':scope > .note-card')) card.style.setProperty('--note-drag-tilt', `${tilt.toFixed(3)}deg`);
    paintedX = x; time = now; frame = requestAnimationFrame(animate);
  };
  move({ clientX, clientY }); frame = requestAnimationFrame(animate);
  return { move, dispose() { if (disposed) return; disposed = true; cancelAnimationFrame(frame); layer.remove(); } };
}

/** Local insertion slots only. The caller owns the authorized order and writes. */
export function createNoteGroupInsertionPreview(grid) {
  const view = grid.ownerDocument.defaultView;
  let session = null, disposed = false;
  const animations = new Map();
  const cancelAnimations = () => { for (const animation of animations.values()) animation.cancel(); animations.clear(); };
  const cards = () => [...grid.children].filter(node => node.hasAttribute('data-group-page'));
  const sameIds = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);
  function clear() {
    cancelAnimations();
    if (!session) return;
    const scrollTop = grid.scrollTop;
    for (const [card, original] of session.originals) {
      // Never reconnect a node removed by an authorized reconciliation.
      if (card.parentElement !== grid) continue;
      card.hidden = original.hidden; card.inert = original.inert;
      if (original.order) card.style.setProperty('order', original.order, original.orderPriority);
      else card.style.removeProperty('order');
    }
    session.gaps.forEach(gap => gap.remove());
    if (session.height.value) grid.style.setProperty('height', session.height.value, session.height.priority);
    else grid.style.removeProperty('height');
    if (session.marker === undefined) delete grid.dataset.groupInsertionBefore;
    else grid.dataset.groupInsertionBefore = session.marker;
    session = null; grid.scrollTop = scrollTop;
  }
  function arrange(index, animate = true) {
    const oldRects = new Map(session.remaining.map(({ card }) => [card, card.getBoundingClientRect()]));
    const scrollTop = grid.scrollTop;
    cancelAnimations(); session.index = index;
    session.remaining.forEach(({ card }, i) => { card.style.order = String(i < index ? i : i + session.gaps.length); });
    session.gaps.forEach((gap, i) => { gap.style.order = String(index + i); });
    grid.dataset.groupInsertionBefore = String(session.remaining[index]?.id ?? '');
    grid.scrollTop = scrollTop;
    if (!animate || view.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const { card } of session.remaining) {
      const before = oldRects.get(card), after = card.getBoundingClientRect();
      // FLIP may begin at the current animated position, but those rectangles
      // are never used to decide the destination under the pointer.
      const scale = card.offsetWidth ? after.width / card.offsetWidth : 1;
      const x = (before.left - after.left) / scale, y = (before.top - after.top) / scale;
      if ((!x && !y) || !card.animate) continue;
      const animation = card.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }],
        { duration: 160, easing: 'cubic-bezier(.2,.7,.2,1)' });
      animations.set(card, animation);
      animation.finished.then(() => { if (animations.get(card) === animation) animations.delete(card); }, () => {});
    }
  }
  function begin(memberIds, selectedIds, nodes) {
    const byId = new Map(nodes.map(card => [String(card.dataset.groupPage), card]));
    const selected = new Set(selectedIds.map(String));
    const members = memberIds.filter(id => byId.has(String(id)));
    const remaining = members.filter(id => !selected.has(String(id))).map(id => ({ id, card: byId.get(String(id)) }));
    const originals = new Map(nodes.map(card => [card, { hidden: card.hidden, inert: card.inert,
      order: card.style.getPropertyValue('order'), orderPriority: card.style.getPropertyPriority('order') }]));
    const scrollTop = grid.scrollTop;
    const height = { value: grid.style.getPropertyValue('height'), priority: grid.style.getPropertyPriority('height') };
    const usedHeight = view.getComputedStyle(grid).height;
    // Incoming slots can add a row. Keep the centered panel still beneath the
    // held pointer and let its existing vertical scroller expose the new row.
    if (parseFloat(usedHeight) > 0) grid.style.height = usedHeight;
    const gaps = selectedIds.map(id => {
      const gap = grid.ownerDocument.createElement('div');
      gap.className = 'note-group-overview__insertion-gap'; gap.dataset.groupInsertionGap = String(id);
      gap.setAttribute('aria-hidden', 'true'); gap.inert = true; return gap;
    });
    const first = members.findIndex(id => selected.has(String(id)));
    session = { memberIds, selectedIds, nodes, remaining, originals, gaps, height, marker: grid.dataset.groupInsertionBefore,
      index: first < 0 ? remaining.length : members.slice(0, first).filter(id => !selected.has(String(id))).length };
    for (const card of nodes) if (selected.has(String(card.dataset.groupPage))) {
      // The native touch stream stays attached to its original connected node.
      card.hidden = true; card.inert = true;
    }
    grid.append(...gaps); arrange(session.index, false); grid.scrollTop = scrollTop;
  }
  function update({ memberIds, selectedIds, clientX, clientY }) {
    if (disposed) return null;
    const bounds = grid.getBoundingClientRect();
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || clientX < bounds.left || clientX > bounds.right ||
      clientY < bounds.top || clientY > bounds.bottom || !selectedIds.length) { clear(); return null; }
    const nodes = cards(), members = [...new Set(memberIds)], selected = [...new Set(selectedIds)];
    if (session && (!sameIds(session.memberIds, members) || !sameIds(session.selectedIds, selected) || !sameIds(session.nodes, nodes))) clear();
    if (!session) begin(members, selected, nodes);
    const rect = grid.getBoundingClientRect(), style = view.getComputedStyle(grid);
    const scale = grid.offsetWidth ? rect.width / grid.offsetWidth : 1;
    const px = value => parseFloat(value) || 0;
    const paddingLeft = px(style.paddingLeft), paddingRight = px(style.paddingRight), paddingTop = px(style.paddingTop);
    const width = grid.clientWidth - paddingLeft - paddingRight;
    const columns = style.gridTemplateColumns.split(/\s+/).map(px).filter(value => value > 0);
    const cardWidth = columns[0] || Math.min(320, width), columnGap = px(style.columnGap), rowGap = px(style.rowGap);
    const columnCount = columns.length || Math.max(1, Math.floor((width + columnGap) / (cardWidth + columnGap)));
    const cardHeight = session.gaps[0].offsetHeight || 276;
    let x = (clientX - rect.left) / scale - grid.clientLeft - paddingLeft;
    if (style.direction === 'rtl') x = width - x;
    const y = (clientY - rect.top) / scale - grid.clientTop - paddingTop + grid.scrollTop;
    const row = Math.max(0, Math.floor((y + rowGap / 2) / (cardHeight + rowGap)));
    const column = Math.max(0, Math.min(columnCount - 1, Math.floor(x / (cardWidth + columnGap))));
    const after = x - column * (cardWidth + columnGap) >= cardWidth / 2;
    const slot = y < 0 ? 0 : Math.max(0, Math.min(session.remaining.length + session.gaps.length, row * columnCount + column + Number(after)));
    // A pointer inside the reserved interval keeps that boundary. Mapping the
    // other fixed slots around it avoids feedback from the cards shifting.
    const index = Math.min(session.remaining.length, slot < session.index ? slot
      : slot > session.index + session.gaps.length ? slot - session.gaps.length : session.index);
    if (index !== session.index) arrange(index);
    return { before_note_id: session.remaining[index]?.id ?? null };
  }
  return { update, clear, dispose() { if (disposed) return; clear(); disposed = true; } };
}
