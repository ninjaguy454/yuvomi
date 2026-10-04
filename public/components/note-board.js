import { NOTE_COLUMNS, NOTE_ROW_HEIGHT, normalizeNoteLayout, projectNoteLayouts } from '/utils/note-board-layout.js';

/** Layout changes commit only after an intentional completed gesture. */
export function wireNoteBoard(grid, { getNotes, canEdit, saveLayout, compact = false, filtered = false, onViewChange = () => {} }) {
  let disposed = false, gesture = null, narrow = compact || grid.clientWidth < 640;
  let suppressClick = false, frame = 0, excludedPointer = null;
  const pending = new Set();
  const gap = () => parseFloat(getComputedStyle(grid).getPropertyValue('--space-3')) || 12;
  function paint(card, layout) {
    const pitch = grid.clientWidth / NOTE_COLUMNS;
    Object.assign(card.style, { left: `${layout.x * pitch}px`, top: `${layout.y * NOTE_ROW_HEIGHT}px`, width: `${layout.width * pitch - gap()}px`, height: `${layout.height * NOTE_ROW_HEIGHT - gap()}px` });
  }
  function refresh() {
    if (disposed) return;
    narrow = compact || grid.clientWidth < 640;
    grid.dataset.boardView = narrow ? 'list' : 'canvas';
    grid.classList.add('notes-board');
    grid.classList.toggle('notes-board--compact', narrow);
    grid.classList.toggle('notes-board--projected', filtered);
    let bottom = 0;
    for (const item of projectNoteLayouts(getNotes(), { filtered })) {
      const card = grid.querySelector(`.note-card[data-id="${item.note_id}"]`);
      if (card) {
        if (narrow) for (const name of ['left', 'top', 'width', 'height']) card.style[name] = '';
        else paint(card, item.layout);
      }
      bottom = Math.max(bottom, item.layout.y + item.layout.height);
    }
    grid.style.minHeight = narrow ? '' : `${bottom * NOTE_ROW_HEIGHT + 96}px`;
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
    frame = requestAnimationFrame(autoscroll);
  }
  function down(event) {
    if (gesture) { if (gesture.pointer !== event.pointerId) cancel(); return; }
    suppressClick = false;
    if (event.button !== 0 || narrow || filtered) return;
    if (event.target.closest('a,button,input,select,textarea,summary,details,[role="checkbox"],[contenteditable="true"]')) {
      if (grid.contains(event.target)) excludedPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      return;
    }
    // Rounded corners are visually part of a card even when hit-testing reaches its grid.
    const card = event.target.closest('.note-card') || (event.target === grid && [...grid.querySelectorAll('.note-card')].reverse().find(card => {
      const r = card.getBoundingClientRect();
      return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    }));
    if (!card || !grid.contains(card)) return;
    const note = getNotes().find(n => n.id === Number(card.dataset.id));
    if (!note || !canEdit(note) || pending.has(note.id)) return;
    const rect = card.getBoundingClientRect();
    const edges = { left: event.clientX - rect.left < 12, right: rect.right - event.clientX < 12, top: event.clientY - rect.top < 12, bottom: rect.bottom - event.clientY < 12 };
    const start = normalizeNoteLayout(note.layout), scroller = scrollParent(card);
    gesture = { note, card, pointer: event.pointerId, start, next: start, x: event.clientX, y: event.clientY,
      lastX: event.clientX, lastY: event.clientY, scroller, scrollY: scroller.scrollTop, active: false,
      edges: Object.values(edges).some(Boolean) ? edges : null };
    suppressClick = false;
    if (gesture.edges) gesture.timer = setTimeout(activate, 450);
  }
  function update() {
    if (!gesture?.active) return;
    const { start, edges, scroller } = gesture;
    const dx = Math.round((gesture.lastX - gesture.x) / (grid.clientWidth / NOTE_COLUMNS));
    const dy = Math.round((gesture.lastY - gesture.y + scroller.scrollTop - gesture.scrollY) / NOTE_ROW_HEIGHT);
    const next = { ...start };
    if (!edges) { next.x += dx; next.y += dy; }
    else {
      if (edges.left) { next.x = Math.max(0, Math.min(start.x + start.width - 3, start.x + dx)); next.width = start.x + start.width - next.x; }
      if (edges.right) next.width = Math.max(3, Math.min(NOTE_COLUMNS - start.x, start.width + dx));
      if (edges.top) { next.y = Math.max(0, start.y + start.height - 100, Math.min(start.y + start.height - 4, start.y + dy)); next.height = start.y + start.height - next.y; }
      if (edges.bottom) next.height = start.height + dy;
    }
    gesture.next = normalizeNoteLayout(next);
    paint(gesture.card, gesture.next);
    grid.style.minHeight = `${Math.max(parseFloat(grid.style.minHeight) || 0, (gesture.next.y + gesture.next.height) * NOTE_ROW_HEIGHT + 96)}px`;
  }
  function move(event) {
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
    frame = requestAnimationFrame(autoscroll);
  }
  async function up(event) {
    if (excludedPointer?.id === event.pointerId) excludedPointer = null;
    if (!gesture || gesture.pointer !== event.pointerId) { setTimeout(() => { suppressClick = false; }, 0); return; }
    const current = gesture; gesture = null;
    release(current);
    suppressClick = current.active;
    setTimeout(() => { suppressClick = false; }, 0);
    if (!current.active || JSON.stringify(current.start) === JSON.stringify(current.next)) { refresh(); return; }
    if (disposed || !canEdit(current.note)) { refresh(); return; }
    pending.add(current.note.id); current.card.setAttribute('aria-busy', 'true');
    try { await saveLayout(current.note, current.next); }
    finally { pending.delete(current.note.id); current.card.removeAttribute('aria-busy'); if (!disposed) refresh(); }
  }
  function click(event) { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); } }
  function key(event) { if (gesture && event.key === 'Escape') { event.preventDefault(); cancel(); } }
  function lost(event) {
    // Touch starts with implicit capture on the hit descendant. Transferring it
    // to the card loses that descendant's capture without ending our gesture.
    if (gesture?.pointer === event.pointerId && event.target === gesture.card) cancel();
  }
  let observedWidth = grid.clientWidth;
  const observer = new ResizeObserver(() => {
    if (grid.clientWidth === observedWidth) return;
    const crossedBreakpoint = (grid.clientWidth < 640) !== (observedWidth < 640);
    const wasNarrow = narrow; observedWidth = grid.clientWidth; cancel(); refresh();
    if (wasNarrow !== narrow || crossedBreakpoint) onViewChange();
  });
  observer.observe(grid);
  window.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  grid.addEventListener('lostpointercapture', lost);
  grid.addEventListener('click', click, true);
  window.addEventListener('keydown', key);
  refresh();
  return {
    refresh,
    busy: () => !!gesture || pending.size > 0,
    destroy() {
      cancel(); disposed = true; observer.disconnect();
      window.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
      grid.removeEventListener('lostpointercapture', lost);
      grid.removeEventListener('click', click, true); window.removeEventListener('keydown', key);
      grid.classList.remove('notes-board', 'notes-board--compact', 'notes-board--projected'); grid.style.minHeight = '';
    },
  };
}
