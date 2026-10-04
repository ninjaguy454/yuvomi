import { NOTE_COLUMNS, NOTE_ROW_HEIGHT, normalizeNoteLayout, projectNoteLayouts, noteCanvasExtent } from '/utils/note-board-layout.js';

/** Layout changes commit only after an intentional completed gesture. */
export function wireNoteBoard(grid, { getNotes, canEdit, saveLayout, compact = false, filtered = false, viewState = {}, onViewChange = () => {} }) {
  const viewport = grid.closest('.notes-scroll'), space = grid.parentElement;
  const viewportWidth = () => viewport.clientWidth - (parseFloat(getComputedStyle(viewport).paddingLeft) || 0) - (parseFloat(getComputedStyle(viewport).paddingRight) || 0);
  let disposed = false, gesture = null, narrow = compact || viewportWidth() < 640;
  let suppressClick = false, frame = 0, excludedPointer = null;
  let navigation = null;
  const touches = new Map();
  viewState.zoom ??= 1;
  viewState.order ??= [];
  const zoom = () => narrow ? 1 : viewState.zoom;
  const pending = new Set();
  const gap = () => parseFloat(getComputedStyle(grid).getPropertyValue('--space-3')) || 12;
  function paint(card, layout) {
    const pitch = viewportWidth() / NOTE_COLUMNS;
    Object.assign(card.style, { left: `${layout.x * pitch}px`, top: `${layout.y * NOTE_ROW_HEIGHT}px`, width: `${layout.width * pitch - gap()}px`, height: `${layout.height * NOTE_ROW_HEIGHT - gap()}px` });
  }
  function layerCards(selectedId) {
    const notes = getNotes(), ids = notes.map(note => note.id);
    viewState.order = [...viewState.order.filter(id => ids.includes(id)), ...ids.filter(id => !viewState.order.includes(id))];
    if (selectedId) viewState.order = [...viewState.order.filter(id => id !== selectedId), selectedId];
    for (const note of notes) {
      const card = grid.querySelector(`.note-card[data-id="${note.id}"]`);
      if (card) card.style.zIndex = String(gesture?.active && gesture.note.id === note.id ? notes.length * 2 + 2
        : card.querySelector('.note-card__menu[open]') ? notes.length * 2 + 1
        : (note.layout?.always_on_top ? notes.length : 0) + viewState.order.indexOf(note.id) + 1);
    }
  }
  function extent(layouts) {
    if (narrow) return;
    const value = noteCanvasExtent(layouts, viewportWidth(), Math.max(320, viewport.clientHeight - 12) / zoom());
    value.width = Math.max(value.width, viewportWidth() / zoom());
    Object.assign(grid.style, { width: `${value.width}px`, minHeight: `${value.height}px`, transform: `scale(${zoom()})` });
    Object.assign(space.style, { width: `${value.width * zoom()}px`, height: `${value.height * zoom()}px` });
    const label = viewport.closest('.notes-page')?.querySelector('#notes-zoom-value');
    if (label) label.textContent = `${Math.round(zoom() * 100)}%`;
  }
  function refresh() {
    if (disposed) return;
    narrow = compact || viewportWidth() < 640;
    grid.dataset.boardView = narrow ? 'list' : 'canvas';
    grid.classList.add('notes-board');
    grid.classList.toggle('notes-board--compact', narrow);
    grid.classList.toggle('notes-board--projected', filtered);
    viewport.classList.toggle('notes-scroll--canvas', !narrow);
    space.classList.toggle('notes-canvas-space--active', !narrow);
    grid.tabIndex = narrow ? -1 : 0;
    if (narrow) { space.style.width = ''; space.style.height = ''; grid.style.width = ''; grid.style.transform = ''; grid.style.minHeight = ''; }
    const projected = projectNoteLayouts(getNotes(), { filtered });
    for (const item of projected) {
      const card = grid.querySelector(`.note-card[data-id="${item.note_id}"]`);
      if (card) {
        if (narrow) for (const name of ['left', 'top', 'width', 'height']) card.style[name] = '';
        else paint(card, item.layout);
      }
    }
    extent(projected.map(item => item.layout)); layerCards();
  }
  function setZoom(value, point) {
    if (narrow || disposed) return;
    const rect = grid.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
    const center = point || { x: bounds.left + viewport.clientWidth / 2, y: bounds.top + viewport.clientHeight / 2 };
    const previous = zoom(), world = { x: (center.x - rect.left) / previous, y: (center.y - rect.top) / previous };
    viewState.zoom = Math.max(.25, Math.min(2, value)); refresh();
    viewport.scrollLeft += world.x * (zoom() - previous);
    viewport.scrollTop += world.y * (zoom() - previous);
  }
  function release(current) {
    clearTimeout(current.timer); cancelAnimationFrame(frame); frame = 0;
    current.card.classList.remove('note-card--moving', 'note-card--resizing');
    if (current.card.hasPointerCapture?.(current.pointer)) current.card.releasePointerCapture(current.pointer);
  }
  function cancel() {
    if (!gesture) return;
    const current = gesture; gesture = null;
    suppressClick = current.active;
    release(current); refresh();
  }
  function scrollParent(card) {
    for (let node = card.parentElement; node; node = node.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
    }
    return document.scrollingElement;
  }
  function activate() {
    if (!gesture || disposed) return;
    gesture.active = true;
    gesture.card.classList.add('note-card--moving');
    if (gesture.edges) gesture.card.classList.add('note-card--resizing');
    gesture.card.setPointerCapture(gesture.pointer);
    layerCards(gesture.note.id);
    frame = requestAnimationFrame(autoscroll);
  }
  function down(event) {
    const inViewport = viewport.contains(event.target);
    if (event.pointerType === 'touch' && inViewport && !narrow) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size >= 2) {
      cancel(); suppressClick = true; excludedPointer = null;
      const [a,b] = [...touches.values()];
      navigation = { kind: 'pinch', distance: Math.hypot(a.x-b.x,a.y-b.y), zoom: zoom(), center: { x: (a.x+b.x)/2, y:(a.y+b.y)/2 } };
      event.preventDefault(); return;
    }
    if (gesture) { if (gesture.pointer !== event.pointerId) cancel(); return; }
    suppressClick = false;
    if (event.button !== 0 || narrow || !inViewport) return;
    const selected = event.target.closest('.note-card');
    if (selected) layerCards(Number(selected.dataset.id));
    if (event.target.closest('a,button,input,select,textarea,summary,details,[role="checkbox"],[contenteditable="true"]')) {
      if (grid.contains(event.target)) excludedPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      return;
    }
    // Rounded corners are visually part of a card even when hit-testing reaches its grid.
    const card = event.target.closest('.note-card') || (event.target === grid && [...grid.querySelectorAll('.note-card')].reverse().find(card => {
      const r = card.getBoundingClientRect();
      return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    }));
    if (!card || !grid.contains(card)) {
      navigation = { kind: 'pan', pointer: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture(event.pointerId); return;
    }
    if (filtered) return;
    const note = getNotes().find(n => n.id === Number(card.dataset.id));
    if (!note || !canEdit(note) || pending.has(note.id)) return;
    const rect = card.getBoundingClientRect();
    const edges = { left: event.clientX - rect.left < 12, right: rect.right - event.clientX < 12, top: event.clientY - rect.top < 12, bottom: rect.bottom - event.clientY < 12 };
    if (note.layout?.position_locked && !Object.values(edges).some(Boolean)) {
      excludedPointer = { id: event.pointerId, x: event.clientX, y: event.clientY }; return;
    }
    const start = normalizeNoteLayout(note.layout), scroller = scrollParent(card);
    gesture = { note, card, pointer: event.pointerId, start, next: start, x: event.clientX, y: event.clientY,
      lastX: event.clientX, lastY: event.clientY, scroller, scrollY: scroller.scrollTop, scrollX: scroller.scrollLeft, scale: zoom(), pitch: viewportWidth() / NOTE_COLUMNS, active: false,
      edges: Object.values(edges).some(Boolean) ? edges : null };
    suppressClick = false;
    if (gesture.edges) gesture.timer = setTimeout(activate, 450);
  }
  function update() {
    if (!gesture?.active) return;
    const { start, edges, scroller } = gesture;
    const dx = Math.round((gesture.lastX - gesture.x + scroller.scrollLeft - gesture.scrollX) / (gesture.pitch * gesture.scale));
    const dy = Math.round((gesture.lastY - gesture.y + scroller.scrollTop - gesture.scrollY) / (NOTE_ROW_HEIGHT * gesture.scale));
    const next = { ...start };
    if (!edges) { next.x += dx; next.y += dy; }
    else {
      if (edges.left) { next.x = Math.max(0, start.x + start.width - 12, Math.min(start.x + start.width - 3, start.x + dx)); next.width = start.x + start.width - next.x; }
      if (edges.right) next.width = start.width + dx;
      if (edges.top) { next.y = Math.max(0, start.y + start.height - 100, Math.min(start.y + start.height - 4, start.y + dy)); next.height = start.y + start.height - next.y; }
      if (edges.bottom) next.height = start.height + dy;
      if (gesture.note.layout?.position_locked) {
        next.x = start.x; next.y = start.y;
        if (edges.left) next.width = start.width - dx;
        if (edges.top) next.height = start.height - dy;
      }
    }
    gesture.next = normalizeNoteLayout(next);
    paint(gesture.card, gesture.next);
    extent(projectNoteLayouts(getNotes(), { filtered }).map(item => item.note_id === gesture.note.id ? gesture.next : item.layout));
  }
  function move(event) {
    if (touches.has(event.pointerId)) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (navigation?.kind === 'pinch') {
      if (touches.size >= 2) {
        const [a,b] = [...touches.values()], center = { x:(a.x+b.x)/2, y:(a.y+b.y)/2 };
        setZoom(navigation.zoom * Math.hypot(a.x-b.x,a.y-b.y) / Math.max(1,navigation.distance), center);
        viewport.scrollLeft -= center.x-navigation.center.x; viewport.scrollTop -= center.y-navigation.center.y;
        navigation.center = center;
      }
      event.preventDefault(); return;
    }
    if (navigation?.kind === 'pan' && navigation.pointer === event.pointerId) {
      if (Math.hypot(event.clientX-navigation.x,event.clientY-navigation.y) >= 7) suppressClick = true;
      viewport.scrollLeft = navigation.left + navigation.x-event.clientX;
      viewport.scrollTop = navigation.top + navigation.y-event.clientY;
      event.preventDefault(); return;
    }
    if (excludedPointer?.id === event.pointerId && Math.hypot(event.clientX - excludedPointer.x, event.clientY - excludedPointer.y) >= 7) suppressClick = true;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    gesture.lastX = event.clientX; gesture.lastY = event.clientY;
    if (!gesture.active) {
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 7) return;
      if (gesture.edges) { cancel(); suppressClick = true; return; }
      activate();
    }
    event.preventDefault(); update();
  }
  function autoscroll() {
    if (!gesture?.active || disposed) return;
    if (!gesture.card.hasPointerCapture(gesture.pointer)) { cancel(); return; }
    const scroller = gesture.scroller;
    const rect = scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    const speed = gesture.lastY > bottom - 48 ? Math.min(18, (gesture.lastY - bottom + 48) / 3)
      : gesture.lastY < top + 48 ? -Math.min(18, (top + 48 - gesture.lastY) / 3) : 0;
    if (speed) { scroller.scrollTop += speed; update(); }
    const bounds = scroller.getBoundingClientRect();
    const speedX = gesture.lastX > bounds.right - 48 ? Math.min(18,(gesture.lastX-bounds.right+48)/3)
      : gesture.lastX < bounds.left + 48 ? -Math.min(18,(bounds.left+48-gesture.lastX)/3) : 0;
    if (speedX) { scroller.scrollLeft += speedX; update(); }
    frame = requestAnimationFrame(autoscroll);
  }
  async function up(event) {
    touches.delete(event.pointerId);
    if (navigation) {
      if (navigation.kind === 'pan' && viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      if (!touches.size) navigation = null;
      setTimeout(() => { suppressClick = false; }, 0); return;
    }
    if (excludedPointer?.id === event.pointerId) excludedPointer = null;
    if (!gesture || gesture.pointer !== event.pointerId) { setTimeout(() => { suppressClick = false; }, 0); return; }
    const current = gesture; gesture = null;
    release(current);
    layerCards();
    suppressClick = current.active;
    setTimeout(() => { suppressClick = false; }, 0);
    if (!current.active || JSON.stringify(current.start) === JSON.stringify(current.next)) { refresh(); return; }
    if (disposed || !canEdit(current.note)) { refresh(); return; }
    pending.add(current.note.id); current.card.setAttribute('aria-busy', 'true');
    try { await saveLayout(current.note, current.next); }
    finally { pending.delete(current.note.id); current.card.removeAttribute('aria-busy'); if (!disposed) refresh(); }
  }
  function click(event) { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); } }
  function key(event) {
    if (event.key === 'Escape' && (gesture || navigation)) { event.preventDefault(); cancel(); navigation = null; touches.clear(); }
    if (event.target !== grid || narrow) return;
    const delta = { ArrowLeft:[-80,0], ArrowRight:[80,0], ArrowUp:[0,-80], ArrowDown:[0,80] }[event.key];
    if (delta) { event.preventDefault(); viewport.scrollBy(...delta); }
  }
  function pointerCancel(event) { touches.delete(event.pointerId); navigation = null; cancel(); }
  function lost(event) {
    if (navigation?.kind === 'pan' && navigation.pointer === event.pointerId && event.target === viewport) {
      navigation = null; touches.delete(event.pointerId);
    }
    // Touch starts with implicit capture on the hit descendant. Transferring it
    // to the card loses that descendant's capture without ending our gesture.
    if (gesture?.pointer === event.pointerId && event.target === gesture.card) cancel();
  }
  function menuToggle(event) { if (event.target.matches('.note-card__menu')) layerCards(); }
  let observedWidth = viewportWidth();
  const observer = new ResizeObserver(() => {
    if (viewportWidth() === observedWidth) return;
    const crossedBreakpoint = (viewportWidth() < 640) !== (observedWidth < 640);
    const wasNarrow = narrow; observedWidth = viewportWidth(); cancel(); navigation = null; touches.clear(); refresh();
    if (wasNarrow !== narrow || crossedBreakpoint) onViewChange();
  });
  observer.observe(viewport);
  window.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', pointerCancel);
  viewport.addEventListener('lostpointercapture', lost);
  grid.addEventListener('toggle', menuToggle, true);
  grid.addEventListener('click', click, true);
  window.addEventListener('keydown', key);
  refresh();
  if (!narrow) { viewport.scrollLeft = viewState.left || 0; viewport.scrollTop = viewState.top || 0; }
  return {
    refresh,
    zoomBy(amount) { cancel(); setZoom(zoom() + amount); },
    resetView() { cancel(); viewState.zoom = 1; refresh(); viewport.scrollLeft = 0; viewport.scrollTop = 0; },
    busy: () => !!gesture || !!navigation || pending.size > 0,
    destroy() {
      if (!narrow) { viewState.left = viewport.scrollLeft; viewState.top = viewport.scrollTop; }
      cancel(); disposed = true; observer.disconnect();
      window.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', pointerCancel);
      viewport.removeEventListener('lostpointercapture', lost);
      grid.removeEventListener('toggle', menuToggle, true);
      grid.removeEventListener('click', click, true); window.removeEventListener('keydown', key);
      grid.classList.remove('notes-board', 'notes-board--compact', 'notes-board--projected');
      viewport.classList.remove('notes-scroll--canvas'); space.classList.remove('notes-canvas-space--active');
      for (const name of ['minHeight','width','transform']) grid.style[name] = '';
      space.style.width = ''; space.style.height = '';
    },
  };
}
