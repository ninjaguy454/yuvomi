import { t } from '../i18n.js';
import { createNoteGroupDraft, freezeNoteGroupCommand, orderedSelection, moveSelectionBefore, newNoteGroupOperationId } from '../utils/note-group-draft.js';
import { createNoteGroupGesture } from '../utils/note-group-gesture.js';
import { createNoteDragPreview, createNoteGroupInsertionPreview } from '../utils/note-drag-motion.js';
import { normalizeNoteLayout, organizeNoteLayouts, NOTE_MAX_POSITION } from '../utils/note-board-layout.js';
import { pushOverlay, dropOverlay } from '../utils/overlay-history.js';
import { renderMarkdownLight } from '../utils/html.js';
import {noteItemAllows} from '../utils/note-permissions.js';

const groupAllows=(group,action)=>noteItemAllows({kind:'group',...group},action);
const noteAllows=(note,action)=>noteItemAllows({kind:'note',note,can_manage:note?.permissions?.arrange!==false},action);

const text = (key, fallback, values) => { const value = t(`notes.groups.${key}`, values); return value === `notes.groups.${key}` ? fallback : value; };
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
function previewContent(content) {
  const container = document.createElement('div'); container.insertAdjacentHTML('beforeend', renderMarkdownLight(content));
  // Preview-only underscore emphasis; identifiers and literal code stay intact.
  const nodes = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
    if (!node.parentElement?.closest('code')) node.textContent = node.textContent.replace(/(^|[^\p{L}\p{N}_])(__?)(?=\S)([^_\n]*?\S)\2(?=$|[^\p{L}\p{N}_])/gu, '$1$3');
  }
  // The whole preview is an activation control. Keep formatting, but avoid
  // nested interactive links and live checklist controls in this browse view.
  container.querySelectorAll('a').forEach(element => { const span = document.createElement('span'); span.append(...element.childNodes); element.replaceWith(span); });
  container.querySelectorAll('input').forEach(element => { element.disabled = true; element.tabIndex = -1; });
  return [...container.childNodes];
}

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
  const single = result === 'individual' && selected.length === 1;
  const x = Number(point.x), y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > NOTE_MAX_POSITION || y > NOTE_MAX_POSITION) return null;
  if (single) return [{ x, y, ...size, position_locked: false, always_on_top: !!group.layout?.always_on_top }];
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
  canStartLayout = () => true,
}) {
  // Display the caller's authorized projection. The complete command board is
  // revision evidence, never a reason to expand a filtered/browse-only view.
  let snapshot = structuredClone(board), source = structuredClone(group);
  let noteById = new Map(snapshot.notes.map(note => [note.id, note]));
  let visibleIds = source.member_ids.filter(id => noteById.has(id));
  let manageable = source.can_manage === true && visibleIds.length === source.member_ids.length;
  const allows = action => manageable && groupAllows(source,action);
  const actionAllowed = action => action==='order'?allows('move'):action==='remove'?allows('ungroup'):action==='add'?allows('group'):allows('group')&&allows('ungroup');
  const selected = new Set(selectedIds.filter(id => visibleIds.includes(id)));
  const destinations = new Map();
  const restoreFocus = document.activeElement, subscriptions = [];
  let closed = false, busy = false, suppressClick = false, dragging = false, canvasDrag = false;
  let currentGroup = source, placement = null, action = null, lastPoint = null, scrollFrame = 0, overlayToken;
  let activePointer = null, highlightedTarget = null, proxy = null, footer = null, dragAnchor = null, nativeSource = null;
  let selectionMode = selected.size > 0, placing = false, writeState = {}, nativeExitTimer = null, nativeOutside = false;
  let backdropPress = null, nativeFinishTimer = null, gestureFocus = null, dragOrigin = null, dragMoved = false;
  const feedbackControls = new Map();
  const cardNotes = new WeakMap();
  const overlay = document.createElement('div'); overlay.className = 'note-group-overview';
  const stage = document.createElement('div'); stage.className = 'note-group-overview__stage';
  const dialog = document.createElement('section'); dialog.className = 'note-group-overview__panel';
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', text('overview', 'Group overview')); dialog.tabIndex = -1;
  const header = document.createElement('header'); header.className = 'note-group-overview__header';
  const title = document.createElement('h2'); title.textContent = text('overviewTitle', 'Notes');
  const count = document.createElement('span'); count.dataset.groupSelectionCount = ''; count.className = 'note-group-overview__count'; count.setAttribute('aria-live', 'polite');
  const mode = button('\u2611', { groupSelectionMode: '' }, text('selectionMode', 'Select notes'));
  const menu = document.createElement('details'); menu.dataset.groupMenu = ''; menu.className = 'note-group-overview__menu';
  const menuToggle = document.createElement('summary'); menuToggle.textContent = '\u22ef'; menuToggle.setAttribute('aria-label', text('actions', 'Actions')); menu.append(menuToggle);
  const closeButton = button('×', { groupClose: '' }, text('close', 'Close group overview'));
  header.append(title);
  header.append(count, mode, menu);
  header.append(closeButton);
  const exit = document.createElement('div'); exit.className = 'note-group-overview__exit'; exit.dataset.groupExit = '';
  exit.textContent = text('exitDrag', 'Hold here to remove'); exit.hidden = true;
  const toolbar = document.createElement('div'); toolbar.className = 'note-group-overview__toolbar';
  menu.append(toolbar);
  const grid = document.createElement('div'); grid.className = 'note-group-overview__grid';
  const tools = document.createElement('div'); tools.className = 'note-group-overview__tools';
  const status = document.createElement('div'); status.className = 'note-group-overview__status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const feedbackActions = document.createElement('div'); feedbackActions.className = 'note-group-overview__footer'; feedbackActions.hidden = true;
  dialog.append(header, grid, tools, status, feedbackActions); stage.append(dialog, exit); overlay.append(stage); document.body.append(overlay);
  let draft = createNoteGroupDraft(snapshot, newNoteGroupOperationId());
  const insertion = createNoteGroupInsertionPreview(grid);

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
  function selection() { return [...selected]; }
  function announce(message) { status.textContent = message; }
  function updateHeader() {
    title.textContent = placing ? text('placeCount', `Place ${selected.size} notes`, { count: selected.size }) : text('overviewTitle', 'Notes');
    dialog.setAttribute('aria-label', title.textContent);
    count.textContent = selected.size ? text('selectedCount', `${selected.size} selected`, { count: selected.size }) : '';
    mode.setAttribute('aria-pressed', String(selectionMode));
    count.hidden = mode.hidden = menu.hidden = placing || !manageable || !!dragPreview || !!standaloneIds.length;
    mode.disabled = busy;
    menu.style.visibility = selected.size ? '' : 'hidden'; menu.inert = !selected.size;
    if (placing || !selected.size) menu.open = false;
  }
  function clearProxy() { proxy?.dispose(); proxy = null; nativeSource?.classList.remove('note-card--drag-source'); nativeSource = null; }
  function paintProxy(session) {
    if (!proxy) {
      const cards = session.selected_ids.map(id => grid.querySelector(`[data-group-page="${id}"]`)).filter(Boolean);
      proxy = createNoteDragPreview(cards, { ...session, selectedIds: session.selected_ids, anchor: dragAnchor || cards[0] });
    }
    proxy?.move(session);
  }
  function stopScroll() { if (scrollFrame) cancelAnimationFrame(scrollFrame); scrollFrame = 0; }
  function highlightTarget(id) {
    highlightedTarget?.classList.remove('is-note-group-target'); highlightedTarget = null;
    const note = snapshot.notes.find(note => note.id === id);
    if (!note?.layout?.position_locked || !noteAllows(note,'group')
      || snapshot.groups.some(group => group.member_ids.includes(id))) return;
    highlightedTarget = host.querySelector(`[data-board-key="note:${id}"]`);
    highlightedTarget?.classList.add('is-note-group-target');
  }
  function renderPages() {
    const focused = document.activeElement, previousScroll = grid.scrollTop;
    const bounds = grid.getBoundingClientRect();
    const anchor = [...grid.querySelectorAll('[data-group-page]')].find(card => !card.hidden && card.getBoundingClientRect().bottom > bounds.top);
    const anchorOffset = anchor?.getBoundingClientRect().top - bounds.top;
    const cards = new Map([...grid.querySelectorAll('[data-group-page]')].map(card => [Number(card.dataset.groupPage), card]));
    const ids = currentGroup.member_ids.filter(id => noteById.has(id));
    for (const [id, card] of cards) if (!ids.includes(id)) {
      if (dragging && card === dragAnchor) { card.hidden = true; card.inert = true; }
      else card.remove();
    }
    ids.forEach((id, index) => {
      const note = noteById.get(id), card = cards.get(id) || document.createElement('article');
      const previous = cardNotes.get(card);
      card.hidden = false; card.inert = false;
      card.className = 'note-card note-group-overview__page'; card.dataset.groupPage = String(id); card.classList.toggle('is-selected', selected.has(id));
      if (typeof note.color === 'string' && CSS.supports('color', note.color)) card.style.setProperty('--note-color', note.color);
      else card.style.removeProperty('--note-color');
      const activate = card.querySelector('[data-group-activate]') || button('', { groupActivate: String(id) }); activate.className = 'note-card__surface note-group-overview__activate';
      activate.setAttribute('aria-label', note.title?.trim() || text('untitled', 'Untitled note'));
      if (id === activeId && currentGroup.id === source.id) activate.setAttribute('aria-current', 'page');
      else activate.removeAttribute('aria-current');
      const heading = activate.querySelector('.note-card__title') || document.createElement('strong'); heading.className = 'note-card__title'; heading.textContent = note.title?.trim() || text('untitled', 'Untitled note');
      const preview = activate.querySelector('.note-card__content') || document.createElement('span'); preview.className = 'note-card__content note-group-overview__excerpt';
      if (!previous || previous.content !== note.content) { const top = preview.scrollTop; preview.replaceChildren(...previewContent(note.content)); preview.scrollTop = top; }
      if (!heading.parentElement) activate.append(heading, preview);
      if (!activate.parentElement) card.append(activate);
      if (manageable && currentGroup.id === source.id && !dragPreview) {
        const toggle = card.querySelector('[data-group-select]') || button('', { groupSelect: String(id) });
        toggle.setAttribute('aria-label', text('selectNote', `Select ${note.title || id}`, { title: note.title || String(id) }));
        toggle.textContent = selected.has(id) ? String(selection().indexOf(id) + 1) : '';
        if (selected.has(id)) toggle.setAttribute('aria-description', text('selectionPosition', `Selection ${selection().indexOf(id) + 1}`, { position: selection().indexOf(id) + 1 }));
        else toggle.removeAttribute('aria-description');
        toggle.className = 'note-group-overview__select'; toggle.hidden = !selectionMode; toggle.disabled = busy; toggle.setAttribute('aria-pressed', String(selected.has(id))); if (!toggle.parentElement) card.append(toggle);
      } else card.querySelector('[data-group-select]')?.remove();
      cardNotes.set(card, note);
      const at = [...grid.children].filter(child => child !== dragAnchor || ids.includes(Number(child.dataset.groupPage)))[index];
      if (at !== card) {
        if (card.parentElement === grid && grid.moveBefore) grid.moveBefore(card, at || null);
        else grid.insertBefore(card, at || null);
      }
    });
    const oldTools = new Map([...toolbar.children].map(control => [control.dataset.groupAction, control]));
    const toolNames = new Set();
    if (manageable && !dragPreview && !standaloneIds.length) for (const [name, label] of [['order', text('order', 'Order')], ['move', text('moveToGroup', 'Move to group')], ['remove', text('remove', 'Remove from group')]]) {
      if(!actionAllowed(name))continue;
      toolNames.add(name);
      const control = oldTools.get(name) || button(label, { groupAction: name }); control.disabled = !selected.size || busy;
      if (!control.parentElement) toolbar.append(control);
    }
    for (const [name, control] of oldTools) if (!toolNames.has(name)) control.remove();
    updateHeader();
    if (anchor?.isConnected && !anchor.hidden) grid.scrollTop += anchor.getBoundingClientRect().top - grid.getBoundingClientRect().top - anchorOffset;
    else grid.scrollTop = previousScroll;
    if (focused && dialog.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }
  function updateSelection(id) {
    clearTools();
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    const focused = document.activeElement;
    const attribute = focused?.hasAttribute('data-group-select') ? 'data-group-select' : 'data-group-activate';
    const focusedId = focused?.getAttribute(attribute); renderPages();
    if (focusedId) grid.querySelector(`[${attribute}="${focusedId}"]`)?.focus();
  }
  function clearTools() {
    const hadFocus = tools.contains(document.activeElement) || footer?.contains(document.activeElement);
    action = null; placement = null; placing = false; destinations.clear(); tools.replaceChildren(); status.textContent = '';
    footer?.remove(); footer = null; grid.hidden = false; dialog.removeAttribute('data-group-place-dialog'); updateHeader();
    if (hadFocus) closeButton.focus({ preventScroll: true });
  }
  function field(labelText, control, parent = tools) { const label = document.createElement('label'); label.textContent = labelText; label.append(control); parent.append(label); return control; }
  function insertionControl(targetGroup, selectionIds) {
    const control = document.createElement('select'); control.dataset.groupBefore = '';
    const remaining = targetGroup.member_ids.filter(id => noteById.has(id) && !selectionIds.includes(id));
    for (const id of action === 'join' ? remaining.slice(0, 1) : remaining) {
      const option = document.createElement('option'); option.value = String(id); option.textContent = action === 'join' ? text('addBeginning', 'Add to beginning') : text('beforeNote', `Before ${noteById.get(id).title || id}`, { title: noteById.get(id).title || String(id) }); control.append(option);
    }
    const append = document.createElement('option'); append.value = ''; append.textContent = action === 'join' ? text('addEnd', 'Add to end') : text('last', 'Last'); control.append(append);
    return field(text('position', 'Position'), control);
  }
  function confirmControls(label = text('place', 'Place')) {
    footer = document.createElement('div'); footer.className = 'note-group-overview__footer';
    const cancel = button(text('cancel', 'Cancel'), { groupCancel: '' });
    if (placing) cancel.dataset.groupExtractChoice = 'cancel';
    footer.append(cancel, button(label, { groupConfirm: '' })); dialog.append(footer);
  }
  function orderSelection() {
    if(!actionAllowed('order'))return;
    clearTools(); menu.open = false; action = 'order'; insertionControl(source, selection()); confirmControls(); tools.querySelector('select')?.focus();
  }
  function moveSelection() {
    if(!actionAllowed(standaloneIds.length?'add':'move'))return;
    clearTools(); menu.open = false; action = standaloneIds.length ? 'join' : 'move';
    const destination = document.createElement('select'); destination.dataset.groupDestination = '';
    for (const item of snapshot.groups.filter(item => groupAllows(item,'group') && item.id !== source.id)) {
      const option = document.createElement('option'); option.value = String(item.id);
      const label = noteById.get(item.member_ids[0])?.title?.trim() || text('untitled', 'Untitled note');
      option.textContent = `${label.length > 60 ? `${label.slice(0, 59)}…` : label} · ${text('dragCount', `${item.member_ids.length} notes`, { count: item.member_ids.length })}`; destination.append(option);
      destinations.set(option.value, { kind: 'group', ...item });
    }
    const grouped = new Set(snapshot.groups.flatMap(item => item.member_ids));
    if (standaloneIds.length <= 1) for (const note of snapshot.notes.filter(note => !grouped.has(note.id) && !standaloneIds.includes(note.id)
      && note.layout?.position_locked && noteAllows(note,'group'))) {
      const option = document.createElement('option'); option.value = `note:${note.id}`;
      option.textContent = `${note.title?.trim() || text('untitled', 'Untitled note')} · ${text('newGroup', 'New group')}`;
      destination.append(option); destinations.set(option.value, { kind: 'note', id: note.id });
    }
    if (!destination.options.length) { announce(text('noDestination', 'No available destination group.')); return; }
    field(text('destination', 'Destination group'), destination);
    const target = destinations.get(destination.value);
    if (target.kind === 'group') insertionControl(target, []);
    confirmControls(); destination.focus();
  }
  function extractionChoices(point = { x: source.layout.x + source.layout.width, y: source.layout.y }) {
    if(!actionAllowed('remove'))return;
    lastPoint = point; previewExtraction(selected.size === 1 || !allows('group') ? 'individual' : 'group', point);
    (tools.querySelector('[data-group-extract-choice]') || footer.querySelector('[data-group-confirm]'))?.focus();
  }
  function previewExtraction(result, point) {
    if(!allows('ungroup') || result==='group'&&!allows('group'))return;
    clearTools(); action = 'extract'; placing = true; grid.hidden = true; exit.hidden = true; dialog.dataset.groupPlaceDialog = ''; updateHeader();
    const choices = document.createElement('div'); choices.className = 'note-group-overview__choices';
    if (selected.size > 1) for (const [value, label] of [['group', text('newGroup', 'New group')], ['individual', text('individual', 'Individual notes')]]) {
      if(value==='group'&&!allows('group'))continue;
      const control = document.createElement('input'); control.type = 'radio'; control.name = `group-result-${draft.operation_id}`; control.value = value; control.dataset.groupExtractChoice = value; control.checked = value === result;
      const row = document.createElement('label'); row.append(control, document.createTextNode(label)); choices.append(row);
    }
    tools.append(choices);
    const position = document.createElement('details'); position.dataset.groupPosition = '';
    const positionToggle = document.createElement('summary'); positionToggle.textContent = text('position', 'Position'); position.append(positionToggle);
    const fields = document.createElement('div'); fields.className = 'note-group-overview__coordinates'; position.append(fields);
    const x = document.createElement('input'), y = document.createElement('input');
    for (const input of [x, y]) { input.type = 'number'; input.min = '0'; input.max = String(NOTE_MAX_POSITION); input.step = 'any'; }
    x.value = String(point.x); y.value = String(point.y); x.dataset.groupX = ''; y.dataset.groupY = '';
    field(text('horizontal', 'Horizontal position'), x, fields); field(text('vertical', 'Vertical position'), y, fields);
    const preview = document.createElement('div'); preview.className = 'note-group-overview__placement'; preview.dataset.groupPlacementPreview = '';
    const calculate = () => {
      preview.replaceChildren();
      result = choices.querySelector('input:checked')?.value || 'individual';
      const placements = noteGroupExtractionPlacements(snapshot, source, selection(), result, { x: x.value, y: y.value });
      placement = placements ? { result, placements } : null;
      const confirm = dialog.querySelector('[data-group-confirm]'); if (confirm) confirm.disabled = !placement;
      if (!placement) { announce(text('noPlacement', 'No room here. Choose another position or use List.')); return; }
      announce('');
      const left = Math.min(...placements.map(rect => rect.x)), top = Math.min(...placements.map(rect => rect.y));
      const width = Math.max(...placements.map(rect => rect.x + rect.width)) - left, height = Math.max(...placements.map(rect => rect.y + rect.height)) - top;
      const scale = Math.min(28, 280 / width, 144 / height);
      for (let index = 0; index < placements.length; index++) {
        const rect = placements[index], box = document.createElement('div'); box.dataset.groupPlacement = JSON.stringify(rect);
        box.className = 'note-group-overview__placement-rect';
        box.textContent = result === 'group' ? text('newGroup', 'New group') : noteById.get(selection()[index]).title || String(selection()[index]);
        box.style.left = `${(rect.x - left) * scale}px`; box.style.top = `${(rect.y - top) * scale}px`;
        box.style.width = `${rect.width * scale}px`; box.style.height = `${rect.height * scale}px`; preview.append(box);
      }
      preview.style.minHeight = `${height * scale}px`;
    };
    tools.append(preview, position); confirmControls(); choices.addEventListener('change', calculate); x.addEventListener('input', calculate); y.addEventListener('input', calculate); calculate();
  }
  function submit(kind, fields) {
    if (!current() || !manageable || busy || !canStartLayout()) return;
    try {
      if (kind === 'reorder' && moveSelectionBefore(source.member_ids, fields.selected_ids, fields.before_note_id).every((id, index) => id === source.member_ids[index])) {
        clearTools(); renderPages(); return;
      }
      const command = freezeNoteGroupCommand(draft, kind, fields);
      const destination = fields.target_group_id && snapshot.groups.find(item => item.id === fields.target_group_id);
      if (destination) {
        source = currentGroup = destination;
        activeId = source.member_ids.includes(activeId) ? activeId : source.member_ids[0];
        if (standaloneIds.length) { selected.clear(); selectionMode = false; }
        standaloneIds = [];
      }
      busy = true;
      insertion.clear(); clearTools(); overlay.hidden = false; renderPages();
      // The page reconciles its latest authorized projection. A delayed result
      // body must not independently overwrite that newer view here.
      Promise.resolve(onCommand(command)).catch(onError).finally(() => {
        if (current()) { busy = !!writeState.phase; renderPages(); }
      });
    } catch (error) { if (!closed) announce(error.message); else onError(error); }
  }
  function finishNative() {
    if (nativeExitTimer !== null) clearTimeout(nativeExitTimer);
    nativeExitTimer = null; nativeOutside = false;
    if (dragPreview) suppressClick = true;
    dragPreview = null; clearProxy(); insertion.clear(); stopScroll();
    dragging = canvasDrag = false; exit.hidden = true; overlay.hidden = false;
    renderPages();
  }
  function releaseNativeTarget() {
    // A completed exit dwell keeps this session dormant until release/cancel.
    // The canvas still owns capture and may enter another group in the meantime.
    if (!overlay.hidden) finishNative();
  }
  function invalidateDraft() {
    gesture.pointerCancel('context-change');
    if (dragPreview) finishNative();
    insertion.clear(); clearProxy(); stopScroll();
    clearTools();
  }
  function updateContext(next = {}) {
    if (!current()) return;
    if (next.filtered) { close(); return; }
    const focused = document.activeElement, hadFocus = dialog.contains(focused);
    invalidateDraft();
    overlay.hidden = false;
    if (next.onCommand) onCommand = next.onCommand;
    if (next.canStartLayout) canStartLayout = next.canStartLayout;
    if (next.board) snapshot = structuredClone(next.board);
    noteById = new Map(snapshot.notes.map(note => [note.id, note]));
    const fresh = snapshot.groups.find(item => item.id === source.id)
      || (standaloneIds.length && snapshot.groups.find(item => standaloneIds.every(id => item.member_ids.includes(id))));
    if (!fresh && !standaloneIds.length) { close(); return; }
    if (fresh) { source = currentGroup = fresh; standaloneIds = []; }
    else {
      const note = noteById.get(standaloneIds[0]);
      if (!note || !noteAllows(note, 'group')) { close(); return; }
      source = currentGroup = { ...source, permissions: note.permissions, layout: note.layout };
    }
    visibleIds = source.member_ids.filter(id => noteById.has(id));
    if (!visibleIds.length) { close(); return; }
    manageable = source.can_manage === true && visibleIds.length === source.member_ids.length;
    for (const id of selected) if (!visibleIds.includes(id)) selected.delete(id);
    activeId = next.activeId ?? activeId;
    if (!visibleIds.includes(activeId)) activeId = visibleIds[0];
    draft = createNoteGroupDraft(snapshot, newNoteGroupOperationId());
    busy = !!writeState.phase; renderPages(); setWriteState(writeState);
    if (hadFocus && !focused.isConnected) (grid.querySelector(`[data-group-select="${selection()[0]}"]`) || closeButton).focus({ preventScroll: true });
  }
  function setWriteState(value = {}) {
    if (closed) return;
    const focused = document.activeElement, hadFocus = dialog.contains(focused);
    writeState = value; busy = !!value.phase;
    if (busy) dialog.setAttribute('aria-busy', 'true'); else dialog.removeAttribute('aria-busy');
    status.textContent = value.message || '';
    const attributes = new Set((value.actions || []).map(entry => entry.attribute));
    for (const [attribute, control] of feedbackControls) if (!attributes.has(attribute)) { control.remove(); feedbackControls.delete(attribute); }
    for (const entry of value.actions || []) {
      let control = feedbackControls.get(entry.attribute);
      if (!control) { control = button(entry.label); control.setAttribute(entry.attribute, ''); feedbackControls.set(entry.attribute, control); feedbackActions.append(control); }
      control.textContent = entry.label;
      control.disabled = value.phase === 'saving' || value.phase === 'recovering';
      control.onclick = () => { if (current() && !control.disabled) Promise.resolve(entry.run()).catch(onError); };
    }
    feedbackActions.hidden = !feedbackActions.childElementCount;
    mode.disabled = busy;
    grid.querySelectorAll('[data-group-select]').forEach(control => { control.disabled = busy; });
    toolbar.querySelectorAll('button').forEach(control => { control.disabled = busy || !selected.size; });
    tools.querySelectorAll('button,select,input').forEach(control => { control.disabled = busy; });
    footer?.querySelectorAll('[data-group-confirm]').forEach(control => { control.disabled = busy || (action === 'extract' && !placement); });
    if (hadFocus && (!focused.isConnected || focused.disabled)) closeButton.focus({ preventScroll: true });
  }
  function confirm() {
    const ids = selection(); if (!ids.length) return;
    const beforeId = tools.querySelector('[data-group-before]')?.value;
    const before = beforeId ? Number(beforeId) : null;
    if (action === 'order') {
      if (moveSelectionBefore(source.member_ids, ids, before).every((id, index) => id === source.member_ids[index])) { clearTools(); return; }
      submit('reorder', { group_id: source.id, selected_ids: ids, before_note_id: before });
    } else if (action === 'move' || action === 'join') {
      const target = destinations.get(tools.querySelector('[data-group-destination]')?.value);
      if (!target) return;
      if (target.kind === 'note') submit('create', standaloneIds.length
        ? { source_note_id: standaloneIds[0], target_note_id: target.id }
        : { source_group_id: source.id, selected_ids: ids, target_note_id: target.id });
      else if (action === 'move') submit('transfer', { source_group_id: source.id, target_group_id: target.id, selected_ids: ids, before_note_id: before });
      else submit('join', { target_group_id: target.id, note_ids: standaloneIds, before_note_id: before });
    }
    else if (action === 'extract' && placement) submit('extract', { source_group_id: source.id, selected_ids: ids, result: placement.result, placements: placement.placements });
  }
  function hitTest(session) {
    if (!current()) return null;
    const element = document.elementFromPoint(session.clientX, session.clientY);
    if (!overlay.hidden && overlay.contains(element)) {
      const card = element.closest('[data-group-page]');
      const valid=currentGroup.id===source.id?allows('move'):allows('ungroup')&&allows('group')&&groupAllows(currentGroup,'group');
      const slot = insertion.update({ memberIds: currentGroup.member_ids, selectedIds: session.selected_ids, clientX: session.clientX, clientY: session.clientY });
      if (slot) return { kind: 'overview', group_id: currentGroup.id, before_note_id: slot.before_note_id, valid };
      if (element.closest('button,input,select,summary,a')) return null;
      if (dragging && (element === overlay || element === stage || element.closest('[data-group-exit]') || session.clientY < grid.getBoundingClientRect().top)) return { kind: 'exit' };
      return null;
    }
    if (canvasHitTest) {const target=canvasHitTest(session);return target?{...target,valid:target.valid&&allows('ungroup')&&(target.kind==='canvas'||allows('group'))}:null;}
    return canvasDrag ? { kind: 'canvas', valid: allows('ungroup') } : null;
  }
  function paintPreview({ state, session, target }) {
    if (!current()) return;
    highlightTarget(state === 'target-ready' && target?.kind === 'note' ? target.id : null);
    if (state === 'holding') { activePointer = session.pointerId; dragOrigin = { x: session.clientX, y: session.clientY }; dragMoved = false; }
    if (state === 'dragging' && !dragging) {
      gestureFocus = document.activeElement;
      selected.clear(); session.selected_ids.forEach(id => selected.add(id)); selectionMode = true;
      // Retain the browser's original touch target while capture takes effect.
      grid.querySelectorAll('[data-group-page]').forEach(card => {
        const checked = selected.has(Number(card.dataset.groupPage));
        card.classList.toggle('is-selected', checked);
        const toggle = card.querySelector('[data-group-select]');
        if (toggle) {
          const position = selection().indexOf(Number(card.dataset.groupPage)) + 1;
          toggle.hidden = false; toggle.setAttribute('aria-pressed', String(checked)); toggle.textContent = checked ? String(position) : '';
          if (checked) toggle.setAttribute('aria-description', text('selectionPosition', `Selection ${position}`, { position })); else toggle.removeAttribute('aria-description');
        }
      });
      toolbar.querySelectorAll('button').forEach(control => { control.disabled = !selected.size || busy; });
      updateHeader();
    }
    dragging = !['holding', 'placement-choice', 'submitting'].includes(state);
    exit.hidden = !dragging;
    if (dragging) paintProxy(session); else { insertion.clear(); clearProxy(); }
    if (dragging) suppressClick = true;
    exit.classList.toggle('is-dwelling', state === 'exit-dwell');
    overlay.dataset.gestureState = state;
    grid.querySelectorAll('[data-group-page]').forEach(card => card.classList.toggle('is-placeholder', dragging && session.selected_ids.includes(Number(card.dataset.groupPage))));
    if (state === 'destination-overview' && currentGroup.id !== target.id) {
      const destination = snapshot.groups.find(item => item.id === target.id && groupAllows(item,'group'));
      if (destination) { insertion.clear(); currentGroup = destination; overlay.hidden = false; renderPages(); }
    }
    if (dragging && !overlay.hidden) insertion.update({ memberIds: currentGroup.member_ids, selectedIds: session.selected_ids, clientX: session.clientX, clientY: session.clientY });
    if (dragging) startScroll(session);
  }
  function startScroll(session) {
    lastPoint = { x: session.clientX, y: session.clientY }; if (scrollFrame) return;
    const step = () => {
      scrollFrame = 0;
      if (closed || (!dragging && !dragPreview)) return;
      const scroller = overlay.hidden ? host.querySelector('.notes-scroll') : grid;
      if (!scroller) return;
      const bounds = scroller.getBoundingClientRect(), edge = 36, speed = 12;
      const delta = (value, start, end) => value < start + edge ? -speed : value > end - edge ? speed : 0;
      if (overlay.hidden) scroller.scrollLeft = Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, scroller.scrollLeft + delta(lastPoint.x, Math.max(0, bounds.left), Math.min(innerWidth, bounds.right))));
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + delta(lastPoint.y, Math.max(0, bounds.top), Math.min(innerHeight, bounds.bottom))));
      if (!overlay.hidden) insertion.update({ memberIds: currentGroup.member_ids, selectedIds: dragPreview ? nativeIds() : selection(), clientX: lastPoint.x, clientY: lastPoint.y });
      scrollFrame = requestAnimationFrame(step);
    };
    scrollFrame = requestAnimationFrame(step);
  }
  const gesture = createNoteGroupGesture({ clientToWorld, hitTest, onPreview: paintPreview,
    onExit(session) { if (!current()) return; insertion.clear(); canvasDrag = true; overlay.hidden = true; stopScroll(); startScroll(session); onExitDrag(session); },
    onDrop(session, target) {
      activePointer = null; dragging = false; insertion.clear(); stopScroll(); restoreGestureFocus(); if (!current()) return;
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
    onCancel() {
      suppressClick = true; activePointer = null; dragging = false; canvasDrag = false; exit.hidden = true; insertion.clear(); clearProxy(); stopScroll(); highlightTarget(null);
      if (!closed) {
        overlay.dataset.gestureState = 'idle'; overlay.hidden = false;
        if (currentGroup.id !== source.id) { currentGroup = source; renderPages(); }
        else {
          // A pre-hold swipe belongs to the original scrollable body. Keep its
          // DOM target and scroll offset alive when pointer arbitration yields.
          grid.querySelectorAll('.is-placeholder').forEach(card => card.classList.remove('is-placeholder'));
          updateHeader();
        }
        restoreGestureFocus();
      }
    },
  });
  function restoreGestureFocus() {
    if (gestureFocus?.isConnected && !gestureFocus.closest('[hidden],[inert]')
      && (document.activeElement === document.body || document.activeElement === host)) gestureFocus.focus({ preventScroll: true });
    gestureFocus = null;
  }
  function pointerDown(event) {
    backdropPress = event.target === overlay && !dragging && !dragPreview ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
    if (!current() || busy || dragPreview || standaloneIds.length) return;
    if (activePointer != null) { gesture.pointerDown(event); return; }
    // A new physical press is a new intent. The compatibility click belonging
    // to the previous released drag may have targeted the capture host instead.
    suppressClick = false;
    const activate = event.target.closest('[data-group-activate]');
    if (!activate || !overlay.contains(activate) || !(allows('move')||allows('ungroup')) || action || !canStartLayout()) return;
    const id = Number(activate.dataset.groupActivate);
    // Keep the pressed DOM target alive until the browser has dispatched its
    // click; a short tap must still activate this page.
    const dragIds = selected.has(id) ? selection() : [id];
    dragAnchor = activate.closest('[data-group-page]');
    let expected;
    try { expected = freezeNoteGroupCommand(draft, 'reorder', { group_id: source.id, selected_ids: dragIds, before_note_id: null }).expected; }
    catch (error) { announce(error.message); return; }
    gesture.pointerDown({ pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: event.isPrimary, button: event.button, clientX: event.clientX, clientY: event.clientY, currentTarget: host }, { selected_ids: dragIds, source_group_id: source.id, expected, can_manage: manageable });
  }
  function click(event) {
    if (!current()) return;
    if (dragging || dragPreview) { event.preventDefault(); event.stopPropagation(); return; }
    if (suppressClick && event.detail !== 0) { suppressClick = false; event.preventDefault(); event.stopPropagation(); return; }
    const element = event.target.closest('button');
    if ((event.target === overlay && backdropPress && Math.hypot(event.clientX-backdropPress.x,event.clientY-backdropPress.y)<7) || element?.hasAttribute('data-group-close')) { close(); return; }
    backdropPress = null;
    if (!element || !overlay.contains(element)) return;
    if (busy) return;
    if (element.hasAttribute('data-group-selection-mode')) { clearTools(); selectionMode = !selectionMode; if (!selectionMode) selected.clear(); renderPages(); mode.focus(); }
    else if (element.hasAttribute('data-group-activate')) { const id = Number(element.dataset.groupActivate); if (selectionMode && manageable && !dragPreview) updateSelection(id); else { close(); onActivate(id, source.id); } }
    else if (manageable && element.hasAttribute('data-group-select')) updateSelection(Number(element.dataset.groupSelect));
    else if (element.dataset.groupAction === 'order') orderSelection();
    else if (element.dataset.groupAction === 'move') moveSelection();
    else if (element.dataset.groupAction === 'remove') extractionChoices();
    else if (element.hasAttribute('data-group-cancel') || element.dataset.groupExtractChoice === 'cancel') { clearTools(); currentGroup = source; renderPages(); }
    else if (element.hasAttribute('data-group-extract-choice')) previewExtraction(element.dataset.groupExtractChoice, lastPoint);
    else if (element.hasAttribute('data-group-confirm')) confirm();
  }
  function keydown(event) {
    if (!current()) return;
    if (event.key === 'Escape' && dragPreview) {
      event.preventDefault(); finishNative(); closeButton.focus();
      // The board must also receive Escape to cancel its captured source drag.
      return;
    }
    if (event.key === 'Escape' && overlay.hidden) {
      event.preventDefault(); event.stopPropagation();
      gesture.pointerCancel('escape'); closeButton.focus(); return;
    }
    if (overlay.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (activePointer != null) { suppressClick = true; gesture.pointerCancel('escape'); closeButton.focus(); }
      else if (menu.open) { menu.open = false; menuToggle.focus(); }
      else if (action) { clearTools(); closeButton.focus(); } else close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),summary,[tabindex="0"]')].filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
  }
  function close({ restore = true } = {}) {
    if (closed) return;
    closed = true; if (nativeExitTimer !== null) clearTimeout(nativeExitTimer); if (nativeFinishTimer !== null) clearTimeout(nativeFinishTimer); insertion.dispose(); clearProxy(); stopScroll(); highlightTarget(null); gesture.dispose(); subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
    overlay.remove(); if (overlayToken != null) dropOverlay(overlayToken);
    if (restore && restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true }); onClose();
  }
  function dispose() { close({ restore: false }); }
  function dragTarget(clientX, clientY) {
    if (!current() || overlay.hidden || !groupAllows(currentGroup,'group')) return null;
    const slot = insertion.update({ memberIds: currentGroup.member_ids, selectedIds: nativeIds(), clientX, clientY });
    return slot ? { group_id: currentGroup.id, before_note_id: slot.before_note_id } : null;
  }
  function nativeIds() { return dragPreview?.item.kind === 'group' ? snapshot.groups.find(item => item.id === dragPreview.item.id)?.member_ids || [] : dragPreview ? [dragPreview.item.id] : []; }
  function containsPoint(clientX, clientY) {
    if (!current() || overlay.hidden) return false;
    if (!dragPreview) return dialog.contains(document.elementFromPoint(clientX, clientY));
    // Crossing the backdrop is not a dismissal. Only a deliberate dwell in
    // the removal area yields this native drag back to the canvas.
    const bounds = dialog.getBoundingClientRect();
    const outside = clientY < bounds.top && clientX >= bounds.left && clientX <= bounds.right;
    if (outside && !nativeOutside) {
      nativeOutside = true; exit.hidden = false; exit.classList.add('is-dwelling');
      nativeExitTimer = setTimeout(() => { nativeExitTimer = null; insertion.clear(); overlay.hidden = true; exit.classList.remove('is-dwelling'); stopScroll(); }, 1000);
    } else if (!outside) {
      nativeOutside = false; if (nativeExitTimer !== null) clearTimeout(nativeExitTimer); nativeExitTimer = null; exit.classList.remove('is-dwelling');
    }
    return true;
  }
  listen(window, 'pointerdown', pointerDown, true);
  listen(window, 'pointermove', event => {
    if (!current()) return;
    if (dragPreview && event.pointerId === dragPreview.pointerId) { proxy?.move(event); startScroll(event); }
    else {
      if (event.pointerId === activePointer && dragOrigin && Math.hypot(event.clientX - dragOrigin.x, event.clientY - dragOrigin.y) > 8) dragMoved = true;
      gesture.pointerMove(event);
    }
  }, { passive: false });
  listen(window, 'pointerup', event => {
    // Revoking a pending capture can precede got/lostpointercapture dispatch.
    // The final release must still cancel instead of submitting that drag.
    if (dragging && activePointer === event.pointerId && !host.hasPointerCapture(event.pointerId)) gesture.pointerCancel('capture-lost');
    if (dragging && activePointer === event.pointerId && !dragMoved) gesture.pointerCancel('no-movement');
    if (gesture.pointerUp(event)) suppressClick = true;
    if (activePointer === event.pointerId) activePointer = null;
    if (dragPreview?.pointerId === event.pointerId) nativeFinishTimer = setTimeout(() => {
      nativeFinishTimer = null; if (current() && dragPreview) finishNative();
    }, 0);
  }, true);
  listen(window, 'pointercancel', event => { gesture.pointerCancel(event); if (dragPreview?.pointerId === event.pointerId) finishNative(); });
  listen(host, 'lostpointercapture', event => {
    gesture.pointerCancel(event);
    if (dragPreview?.pointerId === event.pointerId) finishNative();
  });
  const resize = () => { gesture.pointerCancel('viewport-resize'); if (dragPreview) finishNative(); if (action) clearTools(); };
  listen(window, 'resize', resize);
  if (window.visualViewport) listen(window.visualViewport, 'resize', resize);
  listen(window, 'blur', () => { gesture.pointerCancel('blur'); if (dragPreview) finishNative(); });
  listen(overlay, 'click', click);
  listen(document, 'keydown', keydown, true);
  listen(overlay, 'touchmove', event => { if (dragging) event.preventDefault(); }, { passive: false });
  listen(tools, 'change', event => {
    if (!event.target.hasAttribute('data-group-destination')) return;
    const before = tools.querySelector('[data-group-before]'); before?.parentElement.remove();
    const target = destinations.get(event.target.value);
    if (target?.kind === 'group') {
      const control = insertionControl(target, []);
      tools.insertBefore(control.parentElement, tools.querySelector('[data-group-confirm]'));
    }
  });
  if (authentication.signal) listen(authentication.signal, 'abort', dispose, { once: true });
  overlayToken = pushOverlay(() => { close(); return true; });
  renderPages(); closeButton.focus({ preventScroll: true });
  if (dragPreview) {
    exit.hidden = false;
    nativeSource = [...host.querySelectorAll('[data-board-key]')].find(card => card.dataset.boardKey === dragPreview.item.key);
    const ids = dragPreview.item.kind === 'group' ? snapshot.groups.find(item => item.id === dragPreview.item.id)?.member_ids || [] : [dragPreview.item.id];
    proxy = createNoteDragPreview(nativeSource ? [nativeSource] : [], { ...dragPreview, selectedIds: ids, anchor: nativeSource });
    if (proxy) nativeSource.classList.add('note-card--drag-source');
    startScroll(dragPreview);
  }
  if (current() && manageable) {
    if (initialAction === 'order') orderSelection();
    else if (initialAction === 'move' || initialAction === 'add') moveSelection();
    else if (initialAction === 'remove') extractionChoices();
  }
  return { close, dispose, dragTarget, containsPoint, updateContext, invalidateDraft, setWriteState, finishNative, releaseNativeTarget };
}

/** A page-owned view with renewable command authority. Native drags keep their board owner. */
export function createNoteGroupInteractions(context) {
  const { host, clock = globalThis } = context;
  const viewAuthentication = context.viewAuthentication || context.authentication || {};
  let snapshot = structuredClone(context.board), authentication = context.authentication || {}, writeState = {};
  let disposed = false, overview = null, preview = null, hover = null, hoverTimer = null, lastDrop = null, highlightedTarget = null;
  const current = () => !disposed && !viewAuthentication.signal?.aborted && viewAuthentication.isCurrent?.() !== false;
  const canStartLayout = () => current() && !!authentication && !authentication.signal?.aborted
    && authentication.isCurrent?.() !== false && context.canStartLayout?.() !== false;
  const report = error => context.onError?.(error);
  const command = value => canStartLayout() ? context.onCommand?.(value) : undefined;
  const sourceAllowed = item => {
    if (!item || item.can_manage === false || item.layout?.position_locked) return false;
    if (item.kind === 'group') return snapshot.groups.some(group => group.id === item.id && groupAllows(group,'group')&&groupAllows(group,'ungroup'));
    const note = snapshot.notes.find(note => note.id === item.id);
    return !!note && noteAllows(note,'group') && !note.layout?.position_locked
      && !snapshot.groups.some(group => group.member_ids.includes(note.id));
  };
  const destinationAllowed = item => {
    if (!item || item.can_manage === false) return false;
    if (item.kind === 'group') return snapshot.groups.some(group => group.id === item.id && groupAllows(group,'group'));
    const note = snapshot.notes.find(note => note.id === item.id);
    return !!note && !!note.layout?.position_locked && noteAllows(note,'group')
      && !snapshot.groups.some(group => group.member_ids.includes(note.id));
  };
  function clearHover() {
    if (hoverTimer !== null) clock.clearTimeout(hoverTimer);
    hoverTimer = null; hover = null;
    highlightedTarget?.classList.remove('is-note-group-target'); highlightedTarget = null;
  }
  function promotePreview() { if (preview) { overview = preview; preview = null; } return overview; }
  function leaveTarget() {
    clearHover();
    if (preview) promotePreview()?.releaseNativeTarget();
  }
  function clearOverview() { const old = overview; overview = null; old?.dispose(); }
  function open(options) {
    const view = openNoteGroupOverview({ host, board: snapshot, notes: snapshot.notes, ...options,
      authentication: viewAuthentication, canStartLayout, onCommand: command, onError: report,
      clientToWorld: (x, y) => context.clientToWorld?.(x, y) || { x, y },
      hitTest: session => context.hitTest?.(session), onExitDrag: session => context.onExitDrag?.(session),
      onActivate: (id, groupId) => context.onActivate?.(id, groupId),
      onClose: () => { if (overview === view) overview = null; if (preview === view) { preview = null; clearHover(); } },
    });
    view.setWriteState(writeState); return view;
  }
  function emit(kind, fields) {
    if (!canStartLayout()) return false;
    try {
      const value = freezeNoteGroupCommand(createNoteGroupDraft(snapshot, newNoteGroupOperationId()), kind, fields);
      promotePreview()?.finishNative(); clearHover();
      Promise.resolve(command(value)).catch(report);
    } catch (error) { report(error); }
    return true;
  }
  function onGroupAction(action, item) {
    if (!current()) return;
    leaveTarget(); clearOverview();
    if (item.kind === 'note') {
      if (action !== 'add' || !sourceAllowed(item)) return;
      const note = snapshot.notes.find(note => note.id === item.id);
      if (!canStartLayout()) return;
      overview = open({
        group: { id: null, member_ids: [note.id], can_manage: true, permissions:note.permissions, layout: note.layout }, standaloneIds: [note.id], selectedIds: [note.id],
        activeId: note.id, initialAction: 'add' });
      return;
    }
    const canonical = snapshot.groups.find(group => group.id === item.id);
    if (!canonical) return;
    const group = { ...canonical, member_ids: item.member_ids || canonical.member_ids, can_manage: canonical.can_manage && item.can_manage !== false };
    overview = open({ group, activeId: item.note?.id,
      selectedIds: action === 'overview' ? [] : [item.note?.id || group.member_ids[0]], initialAction: action,
    });
  }
  function hoverTarget(item, session) {
    if (!canStartLayout() || !sourceAllowed(session.item) || !destinationAllowed(item) || item.key === session.item.key) { leaveTarget(); return; }
    if (hover?.item.key === item.key && hover.session.pointerId === session.pointerId && hover.session.item.key === session.item.key) { hover.session = session; return; }
    leaveTarget(); lastDrop = null;
    hover = { item, session, ready: false };
    const expectedHover = hover;
    hoverTimer = clock.setTimeout(() => {
      hoverTimer = null;
      if (!canStartLayout() || hover !== expectedHover) return;
      hover.ready = true;
      if (item.kind === 'note') {
        highlightedTarget = host.querySelector(`[data-board-key="note:${item.id}"]`);
        highlightedTarget?.classList.add('is-note-group-target');
        return;
      }
      const group = snapshot.groups.find(group => group.id === item.id);
      clearOverview();
      preview = open({ group, activeId: context.activePages?.get(group.id) || group.member_ids[0], dragPreview: expectedHover.session });
    }, 400);
  }
  function targetAt(event, session) {
    if (!current() || !hover || hover.session.pointerId !== session.pointerId || hover.session.item.key !== session.item?.key) return null;
    return preview?.containsPoint(event.clientX, event.clientY) ? hover.item : null;
  }
  function dropTarget(item, session) {
    if (!canStartLayout()) return true;
    const key = `${session.pointerId}:${session.item?.key}`;
    if (lastDrop === key) return true;
    if (!sourceAllowed(session.item) || !destinationAllowed(item) || item.key === session.item.key) { leaveTarget(); return false; }
    if (!hover?.ready || hover.item.key !== item.key || hover.session.pointerId !== session.pointerId || hover.session.item.key !== session.item.key) { leaveTarget(); return false; }
    const insertion = preview?.dragTarget(session.clientX, session.clientY);
    if (preview && !insertion) { leaveTarget(); return true; }
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
    disposed = true; clearHover(); const old = preview; preview = null; old?.dispose(); clearOverview(); viewAuthentication.signal?.removeEventListener('abort', dispose);
  }
  function invalidateDraft() {
    authentication = null; clearHover(); promotePreview()?.invalidateDraft();
  }
  function update(next) {
    if (!current()) return;
    const changed = !authentication || authentication.signal !== next.authentication?.signal
      || !!context.filtered !== !!next.filtered || JSON.stringify(snapshot) !== JSON.stringify(next.board);
    context = next; authentication = next.authentication || {}; snapshot = structuredClone(next.board);
    // An unchanged live refresh renews callbacks without cancelling a held
    // gesture or an open keyboard action. Revision/authority changes still
    // discard the old draft before reconciling the authorized projection.
    if (changed) promotePreview()?.updateContext({ board: snapshot, filtered: !!next.filtered });
  }
  function setWriteState(value = {}) { writeState = value; (preview || overview)?.setWriteState(value); }
  viewAuthentication.signal?.addEventListener('abort', dispose, { once: true });
  return { onGroupAction, groupDragBridge: { hoverTarget, leaveTarget, dropTarget, targetAt }, update, invalidateDraft, setWriteState, dispose };
}
