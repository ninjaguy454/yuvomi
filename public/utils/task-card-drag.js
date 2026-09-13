/**
 * Touch movement on a Task card belongs to native scrolling. Only its explicit
 * move handle may start a drag, after a short stationary hold. The caller keeps
 * ownership of permissions, bucket restrictions, and the canonical mutation.
 */
export const TASK_DRAG_HOLD_MS = 180;
export const TASK_DRAG_SLOP_PX = 8;
export const TASK_DRAG_SCROLL_SETTLE_MS = 200;

const HANDLE = '[data-task-drag-handle]';
const CARD = '.kanban-card[data-task-id]';

export function taskDragHandle(target, board) {
  const handle = target?.closest?.(HANDLE);
  return handle && !handle.disabled && board?.contains(handle) ? handle : null;
}

/** Returns a disposer; call it before replacing/removing the board. */
export function bindTaskCardTouchDrag(board, {
  canDrag = () => true,
  onDrop = () => {},
  onDragStateChange = () => {},
} = {}) {
  if (!board) return () => {};
  const doc = board.ownerDocument;
  const win = doc.defaultView;
  let pending = null;
  let timer = null;
  let ghost = null;
  let activeZone = null;
  let lastScrollAt = -Infinity;
  let suppressClickUntil = 0;
  let suppressedTaskId = null;
  let disposed = false;

  function cleanup() {
    clearTimeout(timer);
    timer = null;
    const wasActive = !!pending?.active;
    pending?.handle.classList.remove('task-card__drag-handle--ready');
    pending?.card.classList.remove('kanban-card--dragging');
    ghost?.remove();
    ghost = null;
    board.classList.remove('kanban-board--dragging');
    board.querySelectorAll('.kanban-col__body--over').forEach(zone => zone.classList.remove('kanban-col__body--over'));
    activeZone = null;
    pending = null;
    if (wasActive) onDragStateChange(false);
  }

  function cancelGesture() {
    if (pending) {
      suppressedTaskId = pending.taskId;
      suppressClickUntil = Date.now() + 800;
    }
    cleanup();
  }

  function onStart(event) {
    cleanup();
    suppressClickUntil = 0;
    if (event.touches.length !== 1 || Date.now() - lastScrollAt < TASK_DRAG_SCROLL_SETTLE_MS) return;
    const handle = taskDragHandle(event.target, board);
    const card = handle?.closest(CARD);
    if (!card || !canDrag(card)) return;
    const touch = event.touches[0];
    pending = {
      handle, card, identifier: touch.identifier,
      x: touch.clientX, y: touch.clientY,
      taskId: card.dataset.taskId,
      sourceBucketKey: card.closest('[data-bucket-key]')?.dataset.bucketKey || null,
      ready: false, active: false,
    };
    timer = setTimeout(() => {
      timer = null;
      if (!pending || !board.isConnected || !board.contains(pending.card) || !canDrag(pending.card)) {
        cleanup();
        return;
      }
      pending.ready = true;
      pending.handle.classList.add('task-card__drag-handle--ready');
    }, TASK_DRAG_HOLD_MS);
    // No preventDefault: touching a handle during a flick still permits scroll.
  }

  function onMove(event) {
    if (!pending) return;
    const touch = [...event.touches].find(item => item.identifier === pending.identifier);
    if (event.touches.length !== 1 || !touch || !board.isConnected || !board.contains(pending.card) || !canDrag(pending.card)) {
      cancelGesture();
      return;
    }
    const dx = touch.clientX - pending.x;
    const dy = touch.clientY - pending.y;
    if (!pending.active && Math.hypot(dx, dy) < TASK_DRAG_SLOP_PX) return;
    if (!pending.ready || event.cancelable === false) {
      // Movement before the hold, or a gesture already claimed by the browser,
      // belongs entirely to scrolling. It cannot arm again during this touch.
      cancelGesture();
      return;
    }
    event.preventDefault();
    if (!pending.active) {
      const rect = pending.card.getBoundingClientRect();
      pending.left = rect.left;
      pending.top = rect.top;
      pending.active = true;
      suppressedTaskId = pending.taskId;
      suppressClickUntil = Date.now() + 800;
      ghost = pending.card.cloneNode(true);
      ghost.className = 'kanban-card kanban-card--ghost';
      ghost.setAttribute('aria-hidden', 'true');
      ghost.setAttribute('inert', '');
      ghost.removeAttribute('id');
      ghost.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
      ghost.style.width = `${rect.width}px`;
      doc.body.appendChild(ghost);
      pending.card.classList.add('kanban-card--dragging');
      board.classList.add('kanban-board--dragging');
      onDragStateChange(true);
    }
    ghost.style.left = `${pending.left + dx}px`;
    ghost.style.top = `${pending.top + dy}px`;
    // The ghost is pointer-events:none, so hit testing sees the actual column.
    const zone = doc.elementFromPoint(touch.clientX, touch.clientY)?.closest('[data-drop-zone]');
    if (activeZone !== zone) activeZone?.classList.remove('kanban-col__body--over');
    activeZone = zone && board.contains(zone) ? zone : null;
    activeZone?.classList.add('kanban-col__body--over');
  }

  async function onEnd(event) {
    if (!pending) return;
    // Another finger ending must not finish the active contact.
    if (event.touches.length) { cancelGesture(); return; }
    const result = pending.active && activeZone && canDrag(pending.card)
      ? { taskId: pending.taskId, sourceBucketKey: pending.sourceBucketKey, zone: activeZone }
      : null;
    if (pending.active) suppressClickUntil = Date.now() + 800;
    cleanup();
    if (result) await onDrop(result);
  }

  function onScroll() {
    lastScrollAt = Date.now();
    cancelGesture();
  }
  function onVisibility() { if (doc.hidden) cancelGesture(); }
  function onKey(event) { if (event.key === 'Escape') cancelGesture(); }
  function onClick(event) {
    const handle = taskDragHandle(event.target, board);
    if (handle?.closest(CARD)?.dataset.taskId !== suppressedTaskId || Date.now() >= suppressClickUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function onNativeDrag(event) {
    // Safari/Chromium may also start HTML drag from the same held touch. Keep
    // exactly one gesture owner; mouse drag remains the caller's native path.
    if (pending && taskDragHandle(event.target, board)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
  function onContextMenu(event) {
    if (pending?.ready && taskDragHandle(event.target, board)) event.preventDefault();
  }

  const listeners = [
    [board, 'touchstart', onStart, { passive: true }],
    [board, 'touchmove', onMove, { passive: false }],
    [board, 'touchend', onEnd, { passive: true }],
    [board, 'touchcancel', cancelGesture, { passive: true }],
    [board, 'click', onClick, true],
    [board, 'dragstart', onNativeDrag, true],
    [board, 'contextmenu', onContextMenu],
    [doc, 'scroll', onScroll, { passive: true, capture: true }],
    [doc, 'visibilitychange', onVisibility],
    [doc, 'keydown', onKey],
    [win, 'blur', cancelGesture],
  ];
  listeners.forEach(([target, type, handler, options]) => target?.addEventListener(type, handler, options));
  return () => {
    if (disposed) return;
    disposed = true;
    listeners.forEach(([target, type, handler, options]) => target?.removeEventListener(type, handler, options));
    cleanup();
  };
}
