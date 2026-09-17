const makeSortable = (...args) => import('./sortable.js').then(module => module.makeSortable(...args));

// Move the existing row, never rebuild it: unsaved fields, stable IDs and skill
// picker state stay attached to the same subtask for mouse and keyboard moves.
export function moveSubtaskRow(list, row, destination) {
  const siblings = [...list.children];
  const from = siblings.indexOf(row);
  if (from < 0 || !Number.isInteger(destination) || destination < 0 || destination >= siblings.length || from === destination) return false;
  list.insertBefore(row, destination > from ? siblings[destination].nextElementSibling : siblings[destination]);
  return true;
}

export function bindSubtaskReorder(list, { onChange, isReadOnly = () => false, announce = () => {}, createSortable = makeSortable } = {}) {
  let instance = null, disposed = false, observer = null;
  const changed = (row) => {
    const position = [...list.children].indexOf(row) + 1;
    const title = row.querySelector('[data-task-subtask-title]')?.value.trim() || 'Subtask';
    announce(`${title} moved to position ${position} of ${list.children.length}.`);
    onChange?.();
  };
  const controller = {
    move(row, destination) {
      if (disposed || isReadOnly() || !moveSubtaskRow(list, row, destination)) return false;
      changed(row);
      return true;
    },
    refresh() { instance?.option('disabled', disposed || isReadOnly()); },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      instance?.destroy();
      instance = null;
    },
  };
  controller.ready = createSortable(list, {
    handle: '[data-task-subtask-handle]',
    draggable: '[data-task-subtask-row]',
    // A short swipe gets priority over a drag; only a held dotted handle starts
    // reordering. Inputs, Optional and the skills disclosure never start a drag.
    delay: 220,
    touchStartThreshold: 8,
    onEnd(event) {
      if (disposed || isReadOnly()) { moveSubtaskRow(list, event.item, event.oldDraggableIndex ?? event.oldIndex); return; }
      changed(event.item);
    },
  }).then(sortable => {
    if (disposed || !list.isConnected) { sortable?.destroy(); return null; }
    instance = sortable;
    controller.refresh();
    return sortable;
  }).catch(() => null); // The keyboard action menu remains available offline.
  if (typeof MutationObserver === 'function' && list.ownerDocument?.body) {
    observer = new MutationObserver(() => { if (!list.isConnected) controller.dispose(); });
    observer.observe(list.ownerDocument.body, { childList: true, subtree: true });
  }
  return controller;
}
