import { t } from '../i18n.js';
import { createNoteGroupDraft, freezeNoteGroupCommand, orderedSelection, moveSelectionBefore } from '../utils/note-group-draft.js';
import { createNoteGroupGesture } from '../utils/note-group-gesture.js';
import { normalizeNoteLayout, organizeNoteLayouts, NOTE_MAX_POSITION } from '../utils/note-board-layout.js';
import { pushOverlay, dropOverlay } from '../utils/overlay-history.js';

const text = (key, fallback, values) => { const value = t(`notes.groups.${key}`, values); return value === `notes.groups.${key}` ? fallback : value; };
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Compact grid packing near an explicit anchor. Failure keeps the placement draft local. */
export function noteGroupExtractionPlacements(board, group, selectedIds, result, point) {
  const selected = orderedSelection(group.member_ids, selectedIds), source = normalizeNoteLayout(group.layout);
  const size = { width: source.width, height: source.height };
  const relative = result === 'group' ? [{ layout: { ...size, x: 0, y: 0 } }]
    : organizeNoteLayouts(selected.map(id => ({ id, layout: size })), { includeLocked: true });
  const grouped = new Set(board.groups.flatMap(item => item.member_ids));
  const obstacles = [
    ...board.groups.filter(item => item.id !== group.id || selected.length !== group.member_ids.length).map(item => normalizeNoteLayout(item.layout)),
    ...board.notes.filter(note => !grouped.has(note.id)).map(note => normalizeNoteLayout(note.layout)),
  ];
  const x = Math.round(Number(point.x)), y = Math.round(Number(point.y));
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > NOTE_MAX_POSITION || y > NOTE_MAX_POSITION) return null;
  // Search a bounded neighbourhood; the user can choose another anchor if it is full.
  for (let radius = 0; radius <= 24; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const placements = relative.map(({ layout }) => ({ x: x + dx + layout.x, y: y + dy + layout.y, ...size, position_locked: false, always_on_top: !!group.layout?.always_on_top }));
        if (placements.some(rect => rect.x < 0 || rect.y < 0 || rect.x > NOTE_MAX_POSITION || rect.y > NOTE_MAX_POSITION || obstacles.some(other => overlaps(rect, other)))) continue;
        return placements;
      }
    }
  }
  return null;
}

/** Authorized, local overview. The page owns requests, uncertain retries and invalidation. */
export function openNoteGroupOverview({ host, group, notes, activeId, onActivate = () => {}, onCommand = () => {}, onExitDrag = () => {}, authentication = {},
  board = { notes, groups: [group] }, selectedIds = [], clientToWorld = (x, y) => ({ x, y }), hitTest: canvasHitTest,
  onError = () => {}, onClose = () => {}, dragPreview = null, initialAction = null, standaloneIds = [],
}) {
  // Display the caller's authorized projection. The complete command board is
  // revision evidence, never a reason to expand a filtered/browse-only view.
  const snapshot = structuredClone(board), source = structuredClone(group);
  const noteById = new Map(snapshot.notes.map(note => [note.id, note]));
  const visibleIds = source.member_ids.filter(id => noteById.has(id));
  const manageable = source.can_manage === true && visibleIds.length === source.member_ids.length;
  const selected = new Set(selectedIds.filter(id => visibleIds.includes(id)));
  const restoreFocus = document.activeElement, subscriptions = [];
  let closed = false, busy = false, suppressClick = false, dragging = false, canvasDrag = false;
  let currentGroup = source, placement = null, action = null, lastPoint = null, scrollFrame = 0, overlayToken;
  let activePointer = null;
  const overlay = document.createElement('div'); overlay.className = 'note-group-overview';
  const dialog = document.createElement('section'); dialog.className = 'note-group-overview__panel';
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', text('overview', 'Group overview')); dialog.tabIndex = -1;
  const header = document.createElement('header'); header.className = 'note-group-overview__header';
  const title = document.createElement('h2'); title.textContent = text('overview', 'Group overview');
  const closeButton = button('×', { groupClose: '' }, text('close', 'Close group overview'));
  header.append(closeButton, title);
  const exit = document.createElement('div'); exit.className = 'note-group-overview__exit'; exit.dataset.groupExit = '';
  exit.textContent = text('exit', 'Canvas'); exit.setAttribute('aria-label', text('exit', 'Canvas'));
  const toolbar = document.createElement('div'); toolbar.className = 'note-group-overview__toolbar';
  const grid = document.createElement('div'); grid.className = 'note-group-overview__grid';
  const tools = document.createElement('div'); tools.className = 'note-group-overview__tools';
  const status = document.createElement('div'); status.className = 'note-group-overview__status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  dialog.append(header, exit, toolbar, grid, tools, status); overlay.append(dialog); host.append(overlay);
  const draft = createNoteGroupDraft(snapshot, crypto.randomUUID());

  function button(label, data = {}, ariaLabel) {
    const element = document.createElement('button'); element.type = 'button'; element.textContent = label;
    Object.assign(element.dataset, data); if (ariaLabel) element.setAttribute('aria-label', ariaLabel); return element;
  }
  function listen(target, name, listener, options) {
    target.addEventListener(name, listener, options); subscriptions.push(() => target.removeEventListener(name, listener, options));
  }
  function current() {
    if (closed) return false;
    if (authentication.signal?.aborted || authentication.isCurrent?.() === false) { dispose(); return false; }
    return true;
  }
  function selection() { return source.member_ids.filter(id => selected.has(id)); }
  function announce(message) { status.textContent = message; }
  function stopScroll() { if (scrollFrame) cancelAnimationFrame(scrollFrame); scrollFrame = 0; }
  function renderPages() {
    grid.replaceChildren();
    for (const id of currentGroup.member_ids.filter(id => noteById.has(id))) {
      const note = noteById.get(id), card = document.createElement('article');
      card.className = 'note-group-overview__page'; card.dataset.groupPage = String(id); card.classList.toggle('is-selected', selected.has(id));
      const activate = button('', { groupActivate: String(id) }); activate.className = 'note-group-overview__activate';
      activate.setAttribute('aria-label', note.title?.trim() || text('untitled', 'Untitled note'));
      if (id === activeId && currentGroup.id === source.id) activate.setAttribute('aria-current', 'page');
      const heading = document.createElement('strong'); heading.textContent = note.title?.trim() || text('untitled', 'Untitled note');
      const preview = document.createElement('span'); preview.className = 'note-group-overview__excerpt'; preview.textContent = note.content || '';
      activate.append(heading, preview); card.append(activate);
      if (manageable && currentGroup.id === source.id && !dragPreview) {
        const toggle = button(selected.has(id) ? '✓' : '○', { groupSelect: String(id) }, text('selectNote', `Select ${note.title || id}`, { title: note.title || String(id) }));
        toggle.className = 'note-group-overview__select'; toggle.setAttribute('aria-pressed', String(selected.has(id))); card.append(toggle);
      }
      grid.append(card);
    }
    toolbar.replaceChildren();
    if (manageable && !dragPreview && !standaloneIds.length) for (const [name, label] of [['order', text('order', 'Order')], ['move', text('moveToGroup', 'Move to group')], ['remove', text('remove', 'Remove from group')]]) {
      const control = button(label, { groupAction: name }); control.disabled = !selected.size || busy; toolbar.append(control);
    }
  }
  function updateSelection(id) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    const focused = document.activeElement?.dataset.groupSelect; renderPages();
    if (focused) grid.querySelector(`[data-group-select="${focused}"]`)?.focus();
  }
  function clearTools() { action = null; placement = null; tools.replaceChildren(); status.textContent = ''; }
  function field(labelText, control) { const label = document.createElement('label'); label.textContent = labelText; label.append(control); tools.append(label); return control; }
  function insertionControl(targetGroup, selectionIds) {
    const control = document.createElement('select'); control.dataset.groupBefore = '';
    for (const id of targetGroup.member_ids.filter(id => noteById.has(id) && !selectionIds.includes(id))) {
      const option = document.createElement('option'); option.value = String(id); option.textContent = text('beforeNote', `Before ${noteById.get(id).title || id}`, { title: noteById.get(id).title || String(id) }); control.append(option);
    }
    const append = document.createElement('option'); append.value = ''; append.textContent = text('last', 'Last'); control.append(append);
    return field(text('position', 'Position'), control);
  }
  function confirmControls(label = text('place', 'Place')) {
    tools.append(button(label, { groupConfirm: '' }), button(text('cancel', 'Cancel'), { groupCancel: '' }));
  }
  function orderSelection() {
    clearTools(); action = 'order'; insertionControl(source, selection()); confirmControls(); tools.querySelector('select')?.focus();
  }
  function moveSelection() {
    clearTools(); action = standaloneIds.length ? 'join' : 'move';
    const destination = document.createElement('select'); destination.dataset.groupDestination = '';
    for (const item of snapshot.groups.filter(item => item.can_manage && item.id !== source.id)) {
      const option = document.createElement('option'); option.value = String(item.id);
      option.textContent = item.member_ids.map(id => noteById.get(id)?.title).filter(Boolean).join(' · '); destination.append(option);
    }
    if (!destination.options.length) { announce(text('noDestination', 'No available destination group.')); return; }
    field(text('destination', 'Destination group'), destination);
    insertionControl(snapshot.groups.find(item => item.id === Number(destination.value)), []); confirmControls(); destination.focus();
  }
  function extractionChoices(point = { x: source.layout.x + source.layout.width, y: source.layout.y }) {
    clearTools(); action = 'extract-choice'; lastPoint = point;
    if (selected.size === 1) { previewExtraction('individual', point); return; }
    tools.append(button(text('newGroup', 'New group'), { groupExtractChoice: 'group' }), button(text('individual', 'Individual notes'), { groupExtractChoice: 'individual' }), button(text('cancel', 'Cancel'), { groupExtractChoice: 'cancel' }));
    tools.querySelector('button')?.focus();
  }
  function previewExtraction(result, point) {
    clearTools(); action = 'extract';
    const x = document.createElement('input'), y = document.createElement('input');
    for (const input of [x, y]) { input.type = 'number'; input.min = '0'; input.max = String(NOTE_MAX_POSITION); input.step = '1'; }
    x.value = String(Math.round(point.x)); y.value = String(Math.round(point.y)); x.dataset.groupX = ''; y.dataset.groupY = '';
    field(text('horizontal', 'Horizontal position'), x); field(text('vertical', 'Vertical position'), y);
    const preview = document.createElement('div'); preview.className = 'note-group-overview__placement'; preview.dataset.groupPlacementPreview = '';
    const calculate = () => {
      preview.replaceChildren();
      const placements = noteGroupExtractionPlacements(snapshot, source, selection(), result, { x: x.value, y: y.value });
      placement = placements ? { result, placements } : null;
      const confirm = tools.querySelector('[data-group-confirm]'); if (confirm) confirm.disabled = !placement;
      if (!placement) { announce(text('noPlacement', 'No room here. Choose another position or use List.')); return; }
      announce('');
      for (let index = 0; index < placements.length; index++) {
        const rect = placements[index], box = document.createElement('div'); box.dataset.groupPlacement = JSON.stringify(rect);
        box.className = 'note-group-overview__placement-rect';
        box.textContent = result === 'group' ? text('newGroup', 'New group') : noteById.get(selection()[index]).title || String(selection()[index]);
        box.style.left = `${(rect.x - Math.min(...placements.map(item => item.x))) * 12}px`; box.style.top = `${(rect.y - Math.min(...placements.map(item => item.y))) * 8}px`;
        box.style.width = `${rect.width * 12}px`; box.style.height = `${rect.height * 8}px`; preview.append(box);
      }
      preview.style.minHeight = `${Math.max(...placements.map(rect => rect.y + rect.height)) * 8 - Math.min(...placements.map(rect => rect.y)) * 8}px`;
    };
    tools.append(preview); confirmControls(); x.addEventListener('input', calculate); y.addEventListener('input', calculate); calculate();
  }
  function submit(kind, fields) {
    if (!current() || !manageable || busy) return;
    try {
      const command = freezeNoteGroupCommand(draft, kind, fields);
      busy = true;
      // The page retains this frozen command for Retry. Closing prevents a
      // second operation identity from being created while its result is unknown.
      close(); Promise.resolve(onCommand(command)).catch(onError);
    } catch (error) { if (!closed) announce(error.message); else onError(error); }
  }
  function confirm() {
    const ids = selection(); if (!ids.length) return;
    const beforeId = tools.querySelector('[data-group-before]')?.value;
    const before = beforeId ? Number(beforeId) : null;
    if (action === 'order') {
      if (moveSelectionBefore(source.member_ids, ids, before).every((id, index) => id === source.member_ids[index])) { clearTools(); return; }
      submit('reorder', { group_id: source.id, selected_ids: ids, before_note_id: before });
    } else if (action === 'move') submit('transfer', { source_group_id: source.id, target_group_id: Number(tools.querySelector('[data-group-destination]').value), selected_ids: ids, before_note_id: before });
    else if (action === 'join') submit('join', { target_group_id: Number(tools.querySelector('[data-group-destination]').value), note_ids: standaloneIds, before_note_id: before });
    else if (action === 'extract' && placement) submit('extract', { source_group_id: source.id, selected_ids: ids, result: placement.result, placements: placement.placements });
  }
  function hitTest(session) {
    if (!current()) return null;
    const element = document.elementFromPoint(session.clientX, session.clientY);
    if (!overlay.hidden && overlay.contains(element)) {
      if (element.closest('[data-group-exit]')) return { kind: 'exit' };
      const card = element.closest('[data-group-page]');
      if (card) return { kind: 'overview', group_id: currentGroup.id, before_note_id: Number(card.dataset.groupPage), valid: currentGroup.can_manage === true };
      if (element === grid) return { kind: 'overview', group_id: currentGroup.id, before_note_id: null, valid: currentGroup.can_manage === true };
      return null;
    }
    if (canvasHitTest) return canvasHitTest(session);
    return canvasDrag ? { kind: 'canvas', valid: true } : null;
  }
  function paintPreview({ state, session, target }) {
    if (!current()) return;
    if (state === 'holding') activePointer = session.pointerId;
    dragging = !['holding', 'placement-choice', 'submitting'].includes(state);
    if (dragging) suppressClick = true;
    exit.classList.toggle('is-dwelling', state === 'exit-dwell');
    overlay.dataset.gestureState = state;
    grid.querySelectorAll('[data-group-page]').forEach(card => card.classList.toggle('is-placeholder', dragging && session.selected_ids.includes(Number(card.dataset.groupPage))));
    if (state === 'destination-overview') {
      const destination = snapshot.groups.find(item => item.id === target.id && item.can_manage);
      if (destination) { currentGroup = destination; overlay.hidden = false; renderPages(); }
    }
    if (dragging && !overlay.hidden) startScroll(session);
  }
  function startScroll(session) {
    lastPoint = { x: session.clientX, y: session.clientY }; if (scrollFrame) return;
    const step = () => {
      scrollFrame = 0;
      if (closed || !dragging || overlay.hidden) return;
      const bounds = grid.getBoundingClientRect(), edge = 36, speed = 12;
      const delta = (value, start, end) => value < start + edge ? -speed : value > end - edge ? speed : 0;
      grid.scrollLeft = Math.max(0, Math.min(grid.scrollWidth - grid.clientWidth, grid.scrollLeft + delta(lastPoint.x, bounds.left, bounds.right)));
      grid.scrollTop = Math.max(0, Math.min(grid.scrollHeight - grid.clientHeight, grid.scrollTop + delta(lastPoint.y, bounds.top, bounds.bottom)));
      scrollFrame = requestAnimationFrame(step);
    };
    scrollFrame = requestAnimationFrame(step);
  }
  const gesture = createNoteGroupGesture({ clientToWorld, hitTest, onPreview: paintPreview,
    onExit(session) { if (!current()) return; canvasDrag = true; overlay.hidden = true; stopScroll(); onExitDrag(session); },
    onDrop(session, target) {
      activePointer = null; dragging = false; stopScroll(); if (!current()) return;
      if (target.kind === 'canvas') {
        const point = { x: session.worldX, y: session.worldY };
        if (session.selected_ids.length === 1) {
          const placements = noteGroupExtractionPlacements(snapshot, source, session.selected_ids, 'individual', point);
          if (placements) { submit('extract', { source_group_id: source.id, selected_ids: session.selected_ids, result: 'individual', placements }); return; }
        }
        overlay.hidden = false; currentGroup = source; renderPages(); extractionChoices(point); return;
      }
      if (target.kind === 'note') { submit('create', { source_group_id: source.id, selected_ids: session.selected_ids, target_note_id: target.id }); return; }
      const targetId = target.group_id ?? target.id;
      submit(targetId === source.id ? 'reorder' : 'transfer', targetId === source.id
        ? { group_id: source.id, selected_ids: session.selected_ids, before_note_id: target.before_note_id ?? null }
        : { source_group_id: source.id, target_group_id: targetId, selected_ids: session.selected_ids, before_note_id: target.before_note_id ?? null });
    },
    onCancel() { activePointer = null; dragging = false; canvasDrag = false; stopScroll(); if (!closed) { overlay.dataset.gestureState = 'idle'; currentGroup = source; overlay.hidden = false; renderPages(); } },
  });
  function pointerDown(event) {
    if (!current() || busy || dragPreview || standaloneIds.length) return;
    if (activePointer != null) { gesture.pointerDown(event); return; }
    const activate = event.target.closest('[data-group-activate]');
    if (!activate || !overlay.contains(activate) || !manageable || action) return;
    const id = Number(activate.dataset.groupActivate);
    // Keep the pressed DOM target alive until the browser has dispatched its
    // click; a short tap must still activate this page.
    if (!selected.has(id)) { selected.clear(); selected.add(id); }
    let expected;
    try { expected = freezeNoteGroupCommand(draft, 'reorder', { group_id: source.id, selected_ids: selection(), before_note_id: null }).expected; }
    catch (error) { announce(error.message); return; }
    gesture.pointerDown({ pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: event.isPrimary, button: event.button, clientX: event.clientX, clientY: event.clientY, currentTarget: host }, { selected_ids: selection(), source_group_id: source.id, expected, can_manage: manageable });
  }
  function click(event) {
    if (!current()) return;
    if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopPropagation(); return; }
    const element = event.target.closest('button');
    if (event.target === overlay || element?.hasAttribute('data-group-close')) { close(); return; }
    if (!element || !overlay.contains(element)) return;
    if (element.hasAttribute('data-group-activate')) { const id = Number(element.dataset.groupActivate); close(); onActivate(id); }
    else if (manageable && element.hasAttribute('data-group-select')) updateSelection(Number(element.dataset.groupSelect));
    else if (element.dataset.groupAction === 'order') orderSelection();
    else if (element.dataset.groupAction === 'move') moveSelection();
    else if (element.dataset.groupAction === 'remove') extractionChoices();
    else if (element.hasAttribute('data-group-cancel') || element.dataset.groupExtractChoice === 'cancel') { clearTools(); currentGroup = source; renderPages(); }
    else if (element.hasAttribute('data-group-extract-choice')) previewExtraction(element.dataset.groupExtractChoice, lastPoint);
    else if (element.hasAttribute('data-group-confirm')) confirm();
  }
  function keydown(event) {
    if (!current() || overlay.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (action) { clearTools(); closeButton.focus(); } else close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]')].filter(element => element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
  }
  function close({ restore = true } = {}) {
    if (closed) return;
    closed = true; stopScroll(); gesture.dispose(); subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
    overlay.remove(); if (overlayToken != null) dropOverlay(overlayToken);
    if (restore && restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true }); onClose();
  }
  function dispose() { close({ restore: false }); }
  function dragTarget(clientX, clientY) {
    if (!current() || overlay.hidden || !currentGroup.can_manage) return null;
    const element = document.elementFromPoint(clientX, clientY);
    if (!element || !grid.contains(element)) return null;
    const card = element.closest('[data-group-page]');
    return { group_id: currentGroup.id, before_note_id: card ? Number(card.dataset.groupPage) : null };
  }
  listen(host, 'pointerdown', pointerDown, true);
  listen(window, 'pointermove', event => { if (current()) gesture.pointerMove(event); }, { passive: false });
  listen(window, 'pointerup', event => { if (gesture.pointerUp(event)) suppressClick = true; if (activePointer === event.pointerId) activePointer = null; }, true);
  listen(window, 'pointercancel', event => gesture.pointerCancel(event));
  listen(host, 'lostpointercapture', event => gesture.pointerCancel(event));
  listen(window, 'resize', () => { gesture.pointerCancel('viewport-resize'); if (action) clearTools(); });
  listen(window, 'blur', () => gesture.pointerCancel('blur'));
  listen(overlay, 'click', click);
  listen(document, 'keydown', keydown, true);
  listen(overlay, 'touchmove', event => { if (dragging) event.preventDefault(); }, { passive: false });
  listen(tools, 'change', event => {
    if (!event.target.hasAttribute('data-group-destination')) return;
    const before = tools.querySelector('[data-group-before]'); before?.parentElement.remove();
    const control = insertionControl(snapshot.groups.find(item => item.id === Number(event.target.value)), []);
    tools.insertBefore(control.parentElement, tools.querySelector('[data-group-confirm]'));
  });
  if (authentication.signal) listen(authentication.signal, 'abort', dispose, { once: true });
  overlayToken = pushOverlay(() => { close(); return true; });
  renderPages(); closeButton.focus({ preventScroll: true });
  if (current() && manageable) {
    if (initialAction === 'order') orderSelection();
    else if (initialAction === 'move' || initialAction === 'add') moveSelection();
    else if (initialAction === 'remove') extractionChoices();
  }
  return { close, dispose, dragTarget };
}

/** One page-generation adapter. Native board drags retain their existing owner. */
export function createNoteGroupInteractions({ host, board, onCommand, onActivate = () => {}, authentication = {}, clientToWorld,
  onExitDrag, hitTest, onError = () => {}, clock = globalThis,
}) {
  const snapshot = structuredClone(board);
  let disposed = false, overview = null, preview = null, hover = null, hoverTimer = null, lastDrop = null;
  const current = () => !disposed && !authentication.signal?.aborted && authentication.isCurrent?.() !== false;
  const sourceAllowed = item => {
    if (!item || item.can_manage === false || item.layout?.position_locked) return false;
    if (item.kind === 'group') return snapshot.groups.some(group => group.id === item.id && group.can_manage);
    const note = snapshot.notes.find(note => note.id === item.id);
    return !!note && note.permissions?.edit !== false && note.permissions?.arrange !== false && !note.layout?.position_locked
      && !snapshot.groups.some(group => group.member_ids.includes(note.id));
  };
  const destinationAllowed = item => {
    if (!item || item.can_manage === false) return false;
    if (item.kind === 'group') return snapshot.groups.some(group => group.id === item.id && group.can_manage);
    const note = snapshot.notes.find(note => note.id === item.id);
    return !!note && !!note.layout?.position_locked && note.permissions?.edit !== false && note.permissions?.arrange !== false
      && !snapshot.groups.some(group => group.member_ids.includes(note.id));
  };
  function leaveTarget() {
    if (hoverTimer !== null) clock.clearTimeout(hoverTimer);
    hoverTimer = null; hover = null;
    const old = preview; preview = null; old?.dispose();
  }
  function clearOverview() { const old = overview; overview = null; old?.dispose(); }
  function emit(kind, fields) {
    if (!current()) return false;
    try {
      const command = freezeNoteGroupCommand(createNoteGroupDraft(snapshot, crypto.randomUUID()), kind, fields);
      clearOverview(); leaveTarget();
      if (current()) Promise.resolve(onCommand(command)).catch(onError);
    } catch (error) { onError(error); }
    return true;
  }
  function onGroupAction(action, item) {
    if (!current()) return;
    leaveTarget(); clearOverview();
    if (item.kind === 'note') {
      if (action !== 'add' || !sourceAllowed(item)) return;
      const note = snapshot.notes.find(note => note.id === item.id);
      overview = openNoteGroupOverview({ host, board: snapshot, notes: snapshot.notes,
        group: { id: null, member_ids: [note.id], can_manage: true, layout: note.layout }, standaloneIds: [note.id], selectedIds: [note.id],
        activeId: note.id, initialAction: 'add', authentication, onCommand, onError, onClose: () => { overview = null; } });
      return;
    }
    const canonical = snapshot.groups.find(group => group.id === item.id);
    if (!canonical) return;
    const group = { ...canonical, member_ids: item.member_ids || canonical.member_ids, can_manage: canonical.can_manage && item.can_manage !== false };
    overview = openNoteGroupOverview({ host, board: snapshot, notes: snapshot.notes, group, activeId: item.note?.id,
      selectedIds: action === 'overview' ? [] : [item.note?.id || group.member_ids[0]], initialAction: action,
      authentication, onCommand, onError, clientToWorld, onExitDrag, hitTest,
      onActivate: id => onActivate(id, canonical.id), onClose: () => { overview = null; } });
  }
  function hoverTarget(item, session) {
    if (!current() || !sourceAllowed(session.item) || !destinationAllowed(item) || item.key === session.item.key) { leaveTarget(); return; }
    if (hover?.item.key === item.key && hover.session.pointerId === session.pointerId) { hover.session = session; return; }
    leaveTarget(); lastDrop = null;
    hover = { item, session };
    const expectedHover = hover;
    hoverTimer = clock.setTimeout(() => {
      hoverTimer = null;
      if (!current() || hover !== expectedHover || item.kind !== 'group') return;
      const group = snapshot.groups.find(group => group.id === item.id);
      preview = openNoteGroupOverview({ host, board: snapshot, notes: snapshot.notes, group, activeId: group.member_ids[0], dragPreview: session,
        authentication, onError, onClose: () => { preview = null; } });
    }, 400);
  }
  function targetAt(event, session) {
    if (!current() || !hover || hover.session.pointerId !== session.pointerId || hover.session.item.key !== session.item?.key) return null;
    return preview?.dragTarget(event.clientX, event.clientY) ? hover.item : null;
  }
  function dropTarget(item, session) {
    if (!current()) return true;
    const key = `${session.pointerId}:${session.item?.key}`;
    if (lastDrop === key) return true;
    if (!sourceAllowed(session.item) || !destinationAllowed(item) || item.key === session.item.key) { leaveTarget(); return false; }
    const insertion = preview?.dragTarget(session.clientX, session.clientY);
    const before = insertion?.group_id === item.id ? insertion.before_note_id : null;
    const source = session.item;
    lastDrop = key;
    if (item.kind === 'note') {
      return source.kind === 'group'
        ? emit('create', { source_group_id: source.id, selected_ids: snapshot.groups.find(group => group.id === source.id).member_ids, target_note_id: item.id })
        : emit('create', { source_note_id: source.id, target_note_id: item.id });
    }
    return source.kind === 'group'
      ? emit('transfer', { source_group_id: source.id, target_group_id: item.id, selected_ids: snapshot.groups.find(group => group.id === source.id).member_ids, before_note_id: before })
      : emit('join', { target_group_id: item.id, note_ids: [source.id], before_note_id: before });
  }
  function dispose() {
    if (disposed) return;
    disposed = true; leaveTarget(); clearOverview(); authentication.signal?.removeEventListener('abort', dispose);
  }
  authentication.signal?.addEventListener('abort', dispose, { once: true });
  return { onGroupAction, groupDragBridge: { hoverTarget, leaveTarget, dropTarget, targetAt }, dispose };
}
