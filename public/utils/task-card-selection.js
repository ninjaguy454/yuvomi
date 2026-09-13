/** List-only selection gesture. The caller owns permissions and selection state. */
export const TASK_SELECTION_HOLD_MS = 1000;
export const TASK_SELECTION_SLOP_PX = 8;
export const TASK_SELECTION_SCROLL_SETTLE_MS = 200;

const CARD = '.task-card.activity-card';
const TITLE = '.activity-card__open[data-action="open-task"]';
const INTERACTIVE = 'button, input, select, textarea, a, label, summary, [data-action], [role="button"], [role="checkbox"], [role="switch"], [contenteditable]:not([contenteditable="false"])';
const SUBTASK = '[data-subtask-id], .subtask-item, .activity-card__subtasks';

function listCard(target, root) {
  const card = target?.closest?.(CARD);
  if (!card || !root.contains(card) || card.classList.contains('kanban-card')) return null;
  // A nested child action must never select its parent's Task.
  if (!card.parentElement?.matches('.swipe-row') || target.closest(SUBTASK)) return null;
  return card;
}

function selectionTarget(target, root, { titleOnly = false } = {}) {
  const card = listCard(target, root);
  if (!card) return null;
  const control = target.closest(INTERACTIVE);
  const title = target.closest(TITLE);
  if (control && (control !== title || title?.closest(CARD) !== card || title.disabled
    || String(title.dataset.id) !== String(card.dataset.taskId))) return null;
  return titleOnly && !title ? null : card;
}

/**
 * Holds select after one stationary second. Swipes remain native and can never
 * re-arm during the same contact. Shift+Space on the primary title is the
 * keyboard equivalent. Dispose on page unmount; DOM rows may reconcile freely.
 */
export function bindTaskCardSelection(root, {
  canSelect = () => true,
  onSelect = () => {},
} = {}) {
  if (!root) return () => {};
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const contacts = new Set();
  let pending = null;
  let timer = null;
  let suppressed = null;
  let claimedTouchId = null;
  let activatedPointer = null;
  let lastScrollAt = -Infinity;
  let disposed = false;

  function cancel() {
    clearTimeout(timer);
    timer = null;
    pending = null;
  }
  function reset() { cancel(); contacts.clear(); suppressed = null; claimedTouchId = null; activatedPointer = null; }
  function suppress(card) {
    suppressed = { id: card.dataset.taskId, until: Date.now() + 1000 };
  }
  function onDown(event) {
    contacts.add(event.pointerId);
    if (contacts.size !== 1 || event.isPrimary === false) { cancel(); return; }
    cancel();
    // A new, independent tap is not the click produced by the previous hold.
    suppressed = null;
    activatedPointer = null;
    if (event.button !== 0 || Date.now() - lastScrollAt < TASK_SELECTION_SCROLL_SETTLE_MS) return;
    const card = selectionTarget(event.target, root);
    if (!card || !canSelect(card)) return;
    pending = { card, pointerId: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY, activated: false };
    timer = setTimeout(() => {
      timer = null;
      if (!pending || !root.isConnected || !root.contains(pending.card) || !canSelect(pending.card)) {
        cancel(); return;
      }
      pending.activated = true;
      activatedPointer = { pointerId: pending.pointerId, taskId: pending.card.dataset.taskId };
      if (pending.pointerType === 'touch') claimedTouchId = pending.card.dataset.taskId;
      suppress(pending.card);
      onSelect(pending.card);
    }, TASK_SELECTION_HOLD_MS);
    // No pointer capture or preventDefault: the browser still owns scrolling.
  }
  function onMove(event) {
    if (!pending || event.pointerId !== pending.pointerId) return;
    if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) >= TASK_SELECTION_SLOP_PX) cancel();
  }
  function onUp(event) {
    contacts.delete(event.pointerId);
    // Inserting selection controls may restore scroll, canceling the timer's
    // pending state. The held contact still owns its eventual release click.
    if (activatedPointer?.pointerId === event.pointerId) {
      suppressed = { id: activatedPointer.taskId, until: Date.now() + 1000 };
      activatedPointer = null;
    }
    if (pending?.pointerId !== event.pointerId) return;
    if (pending.activated) suppress(pending.card);
    cancel();
  }
  function onCancel(event) {
    contacts.delete(event.pointerId);
    if (activatedPointer?.pointerId === event.pointerId) activatedPointer = null;
    cancel();
  }
  function onScroll() { lastScrollAt = Date.now(); cancel(); }
  function onVisibility() { if (doc.hidden) reset(); }
  function onClick(event) {
    if (!suppressed) return;
    const card = listCard(event.target, root);
    if (Date.now() > suppressed.until) { suppressed = null; return; }
    if (card?.dataset.taskId !== suppressed.id) return;
    suppressed = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function onKey(event) {
    if (event.key === 'Escape') { cancel(); return; }
    if (event.key !== ' ' || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const card = selectionTarget(event.target, root, { titleOnly: true });
    if (!card || !canSelect(card)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) onSelect(card);
  }
  function onContextMenu(event) {
    // Mobile long-press menus may arrive before the one-second threshold.
    // Only the pending eligible selection surface owns that contextual gesture.
    if (pending && listCard(event.target, root) === pending.card) event.preventDefault();
  }
  function onTouchMove(event) {
    // An already selected hold cannot also become the legacy List swipe-to-
    // complete/edit action. Let native scrolling continue, and let touchend
    // reach the row so its untouched swipe state and compositor hint reset.
    if (claimedTouchId && listCard(event.target, root)?.dataset.taskId === claimedTouchId) event.stopPropagation();
  }
  function onTouchEnd() { claimedTouchId = null; }
  const listeners = [
    [doc, 'pointerdown', onDown, { passive: true, capture: true }],
    [doc, 'pointermove', onMove, { passive: true, capture: true }],
    [doc, 'pointerup', onUp, { passive: true, capture: true }],
    [doc, 'pointercancel', onCancel, { passive: true, capture: true }],
    [doc, 'scroll', onScroll, { passive: true, capture: true }],
    [doc, 'touchmove', onTouchMove, { passive: true, capture: true }],
    [doc, 'touchend', onTouchEnd, { passive: true, capture: true }],
    [doc, 'touchcancel', onTouchEnd, { passive: true, capture: true }],
    [root, 'click', onClick, true],
    [root, 'keydown', onKey, true],
    [root, 'contextmenu', onContextMenu],
    [doc, 'visibilitychange', onVisibility],
    [win, 'blur', reset],
    [win, 'pagehide', reset],
  ];
  listeners.forEach(([target, type, handler, options]) => target?.addEventListener(type, handler, options));
  return () => {
    if (disposed) return;
    disposed = true;
    listeners.forEach(([target, type, handler, options]) => target?.removeEventListener(type, handler, options));
    reset();
  };
}
