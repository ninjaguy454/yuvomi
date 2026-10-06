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
