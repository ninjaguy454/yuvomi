import { NOTE_COLUMNS, NOTE_ROW_HEIGHT, normalizeNoteLayout, projectNoteLayouts } from '/utils/note-board-layout.js';

/** Explicit handles leave ordinary touch scrolling and checklist taps untouched. */
export function wireNoteBoard(grid, { getNotes, canEdit, saveLayout, compact = false, filtered = false }) {
  let disposed = false, gesture = null, narrow = false, suppressClick = false;
  const pending = new Set();
  const gap = () => parseFloat(getComputedStyle(grid).getPropertyValue('--space-3')) || 12;
  function paint(card, layout) {
    const pitch = grid.clientWidth / NOTE_COLUMNS;
    Object.assign(card.style, { left: `${layout.x * pitch}px`, top: `${layout.y * NOTE_ROW_HEIGHT}px`, width: `${layout.width * pitch - gap()}px`, height: `${layout.height * NOTE_ROW_HEIGHT - gap()}px` });
  }
  function refresh() {
    if (disposed) return;
    narrow = compact || grid.clientWidth < 900;
    grid.classList.add('notes-board');
    grid.classList.toggle('notes-board--compact', narrow);
    grid.classList.toggle('notes-board--projected', filtered);
    let bottom = 0;
    for (const item of projectNoteLayouts(getNotes(), { compact: narrow, filtered })) {
      const card = grid.querySelector(`.note-card[data-id="${item.note_id}"]`);
      if (card) paint(card, item.layout);
      bottom = Math.max(bottom, item.layout.y + item.layout.height);
    }
    grid.style.minHeight = `${bottom * NOTE_ROW_HEIGHT + 96}px`;
  }
  function cancel() {
    if (!gesture) return;
    suppressClick = true;
    const handle = gesture.handle;
    const pointer = gesture.pointer;
    gesture.card.classList.remove('note-card--moving');
    gesture = null;
    if (handle.hasPointerCapture?.(pointer)) handle.releasePointerCapture(pointer);
    refresh();
  }
  function down(event) {
    const handle = event.target.closest('[data-board-handle]');
    if (!handle || event.button !== 0 || narrow || filtered || gesture) return;
    const card = handle.closest('.note-card');
    const note = getNotes().find(n => n.id === Number(card.dataset.id));
    if (!note || !canEdit(note) || pending.has(note.id)) return;
    event.preventDefault(); event.stopPropagation();
    const start = normalizeNoteLayout(note.layout);
    gesture = { note, card, handle, pointer: event.pointerId, mode: handle.dataset.boardHandle, start, next: start, x: event.clientX, y: event.clientY };
    card.classList.add('note-card--moving');
    handle.setPointerCapture(event.pointerId);
  }
  function move(event) {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    event.preventDefault();
    const dx = Math.round((event.clientX - gesture.x) / (grid.clientWidth / NOTE_COLUMNS));
    const dy = Math.round((event.clientY - gesture.y) / NOTE_ROW_HEIGHT);
    const { start, mode } = gesture;
    gesture.next = normalizeNoteLayout(mode === 'move'
      ? { ...start, x: start.x + dx, y: start.y + dy }
      : { ...start, width: Math.min(NOTE_COLUMNS - start.x, start.width + dx), height: start.height + dy });
    paint(gesture.card, gesture.next);
    grid.style.minHeight = `${Math.max(parseFloat(grid.style.minHeight) || 0, (gesture.next.y + gesture.next.height) * NOTE_ROW_HEIGHT + 96)}px`;
  }
  async function up(event) {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    const current = gesture;
    gesture = null;
    current.card.classList.remove('note-card--moving');
    if (current.handle.hasPointerCapture?.(event.pointerId)) current.handle.releasePointerCapture(event.pointerId);
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (JSON.stringify(current.start) === JSON.stringify(current.next)) { refresh(); return; }
    pending.add(current.note.id); current.card.setAttribute('aria-busy', 'true');
    try { await saveLayout(current.note, current.next); }
    finally { pending.delete(current.note.id); current.card.removeAttribute('aria-busy'); if (!disposed) refresh(); }
  }
  function click(event) {
    if (suppressClick || event.target.closest('[data-board-handle]')) { event.preventDefault(); event.stopImmediatePropagation(); }
  }
  function endCancelledPointer() { if (!gesture) setTimeout(() => { suppressClick = false; }, 0); }
  function key(event) { if (gesture && event.key === 'Escape') { event.preventDefault(); cancel(); } }
  let observedWidth = grid.clientWidth;
  const observer = new ResizeObserver(() => {
    if (grid.clientWidth === observedWidth) return;
    observedWidth = grid.clientWidth; cancel(); refresh();
  });
  observer.observe(grid);
  grid.addEventListener('pointerdown', down);
  grid.addEventListener('pointermove', move);
  grid.addEventListener('pointerup', up);
  grid.addEventListener('pointercancel', cancel);
  grid.addEventListener('click', click, true);
  window.addEventListener('keydown', key);
  window.addEventListener('pointerup', endCancelledPointer, true);
  refresh();
  return {
    refresh,
    busy: () => !!gesture || pending.size > 0,
    destroy() {
      cancel(); disposed = true; observer.disconnect();
      grid.removeEventListener('pointerdown', down); grid.removeEventListener('pointermove', move);
      grid.removeEventListener('pointerup', up); grid.removeEventListener('pointercancel', cancel);
      grid.removeEventListener('click', click, true); window.removeEventListener('keydown', key);
      window.removeEventListener('pointerup', endCancelledPointer, true);
      grid.classList.remove('notes-board', 'notes-board--compact', 'notes-board--projected'); grid.style.minHeight = '';
    },
  };
}
