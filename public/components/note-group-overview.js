import { t } from '../i18n.js';
import { createNoteGroupDraft, freezeNoteGroupCommand, orderedSelection, moveSelectionBefore, newNoteGroupOperationId } from '../utils/note-group-draft.js';
import { createNoteGroupGesture } from '../utils/note-group-gesture.js';
import { normalizeNoteLayout, organizeNoteLayouts, NOTE_MAX_POSITION } from '../utils/note-board-layout.js';
import { pushOverlay, dropOverlay } from '../utils/overlay-history.js';
import { renderMarkdownLight } from '../utils/html.js';
import {noteItemAllows} from '../utils/note-permissions.js';

const groupAllows=(group,action)=>noteItemAllows({kind:'group',...group},action);
const noteAllows=(note,action)=>noteItemAllows({kind:'note',note,can_manage:note?.permissions?.arrange!==false},action);

const text = (key, fallback, values) => { const value = t(`notes.groups.${key}`, values); return value === `notes.groups.${key}` ? fallback : value; };
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
function previewText(content) {
  const template = document.createElement('template'); template.innerHTML = renderMarkdownLight(content);
  // Preview-only underscore emphasis; identifiers and literal code stay intact.
  const nodes = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
    if (!node.parentElement?.closest('code')) node.textContent = node.textContent.replace(/(^|[^\p{L}\p{N}_])(__?)(?=\S)([^_\n]*?\S)\2(?=$|[^\p{L}\p{N}_])/gu, '$1$3');
  }
  template.content.querySelectorAll('br').forEach(element => element.replaceWith('\n'));
  template.content.querySelectorAll('p,li,blockquote,div').forEach(element => element.append('\n'));
  return template.content.textContent.trim();
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
}) {
  // Display the caller's authorized projection. The complete command board is
  // revision evidence, never a reason to expand a filtered/browse-only view.
  const snapshot = structuredClone(board), source = structuredClone(group);
  const noteById = new Map(snapshot.notes.map(note => [note.id, note]));
  const visibleIds = source.member_ids.filter(id => noteById.has(id));
  const manageable = source.can_manage === true && visibleIds.length === source.member_ids.length;
  const allows = action => manageable && groupAllows(source,action);
  const actionAllowed = action => action==='order'?allows('move'):action==='remove'?allows('ungroup'):action==='add'?allows('group'):allows('group')&&allows('ungroup');
  const selected = new Set(selectedIds.filter(id => visibleIds.includes(id)));
  const destinations = new Map();
  const restoreFocus = document.activeElement, subscriptions = [];
  let closed = false, busy = false, suppressClick = false, dragging = false, canvasDrag = false;
  let currentGroup = source, placement = null, action = null, lastPoint = null, scrollFrame = 0, overlayToken;
  let activePointer = null, highlightedTarget = null, proxy = null, footer = null;
  let selectionMode = selected.size > 0, placing = false;
  const overlay = document.createElement('div'); overlay.className = 'note-group-overview';
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
  if (manageable && !dragPreview && !standaloneIds.length) header.append(count, mode, menu);
  header.append(closeButton);
  const exit = document.createElement('div'); exit.className = 'note-group-overview__exit'; exit.dataset.groupExit = '';
  const exitLabel = document.createElement('span'), exitTime = document.createElement('span');
  exitLabel.textContent = text('exitDrag', 'Exit'); exitTime.textContent = text('exitDwell', '1 s'); exit.append(exitLabel, exitTime); exit.hidden = true;
  const toolbar = document.createElement('div'); toolbar.className = 'note-group-overview__toolbar';
  menu.append(toolbar);
  const grid = document.createElement('div'); grid.className = 'note-group-overview__grid';
  const tools = document.createElement('div'); tools.className = 'note-group-overview__tools';
  const status = document.createElement('div'); status.className = 'note-group-overview__status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  dialog.append(header, grid, tools, status); overlay.append(dialog, exit); document.body.append(overlay);
  const draft = createNoteGroupDraft(snapshot, newNoteGroupOperationId());

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
  function updateHeader() {
    title.textContent = placing ? text('placeCount', `Place ${selected.size} notes`, { count: selected.size }) : text('overviewTitle', 'Notes');
    dialog.setAttribute('aria-label', title.textContent);
    count.textContent = selected.size ? text('selectedCount', `${selected.size} selected`, { count: selected.size }) : '';
    mode.setAttribute('aria-pressed', String(selectionMode));
    count.hidden = mode.hidden = menu.hidden = placing;
    menu.style.visibility = selected.size ? '' : 'hidden'; menu.inert = !selected.size;
    if (placing || !selected.size) menu.open = false;
  }
  function clearProxy() { proxy?.remove(); proxy = null; }
  function paintProxy(session) {
    if (!proxy) { proxy = document.createElement('div'); proxy.className = 'note-group-drag-proxy'; proxy.dataset.groupDragProxy = ''; proxy.setAttribute('aria-hidden', 'true'); document.body.append(proxy); }
    proxy.dataset.selectedIds = JSON.stringify(session.selected_ids);
    proxy.textContent = session.selected_ids.length === 1 ? noteById.get(session.selected_ids[0])?.title || text('untitled', 'Untitled note') : text('dragCount', `${session.selected_ids.length} notes`, { count: session.selected_ids.length });
    const rect = proxy.getBoundingClientRect();
    proxy.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, session.clientX + 18))}px`;
    proxy.style.top = `${Math.max(8, Math.min(innerHeight - rect.height - 8, session.clientY - rect.height - 20))}px`;
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
    grid.replaceChildren();
    for (const id of currentGroup.member_ids.filter(id => noteById.has(id))) {
      const note = noteById.get(id), card = document.createElement('article');
      card.className = 'note-group-overview__page'; card.dataset.groupPage = String(id); card.classList.toggle('is-selected', selected.has(id));
      if (typeof note.color === 'string' && CSS.supports('color', note.color)) card.style.setProperty('--note-color', note.color);
      const activate = button('', { groupActivate: String(id) }); activate.className = 'note-group-overview__activate';
      activate.setAttribute('aria-label', note.title?.trim() || text('untitled', 'Untitled note'));
      if (id === activeId && currentGroup.id === source.id) activate.setAttribute('aria-current', 'page');
      const heading = document.createElement('strong'); heading.textContent = note.title?.trim() || text('untitled', 'Untitled note');
      const preview = document.createElement('span'); preview.className = 'note-group-overview__excerpt'; preview.textContent = previewText(note.content);
      activate.append(heading, preview); card.append(activate);
      if (manageable && currentGroup.id === source.id && !dragPreview) {
        const toggle = button(selected.has(id) ? '✓' : '○', { groupSelect: String(id) }, text('selectNote', `Select ${note.title || id}`, { title: note.title || String(id) }));
        toggle.className = 'note-group-overview__select'; toggle.hidden = !selectionMode; toggle.setAttribute('aria-pressed', String(selected.has(id))); card.append(toggle);
      }
      grid.append(card);
    }
    toolbar.replaceChildren();
    if (manageable && !dragPreview && !standaloneIds.length) for (const [name, label] of [['order', text('order', 'Order')], ['move', text('moveToGroup', 'Move to group')], ['remove', text('remove', 'Remove from group')]]) {
      if(!actionAllowed(name))continue;
      const control = button(label, { groupAction: name }); control.disabled = !selected.size || busy; toolbar.append(control);
    }
    updateHeader();
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
    action = null; placement = null; placing = false; destinations.clear(); tools.replaceChildren(); status.textContent = '';
    footer?.remove(); footer = null; grid.hidden = false; dialog.removeAttribute('data-group-place-dialog'); updateHeader();
  }
  function field(labelText, control, parent = tools) { const label = document.createElement('label'); label.textContent = labelText; label.append(control); parent.append(label); return control; }
  function insertionControl(targetGroup, selectionIds) {
    const control = document.createElement('select'); control.dataset.groupBefore = '';
    for (const id of targetGroup.member_ids.filter(id => noteById.has(id) && !selectionIds.includes(id))) {
      const option = document.createElement('option'); option.value = String(id); option.textContent = text('beforeNote', `Before ${noteById.get(id).title || id}`, { title: noteById.get(id).title || String(id) }); control.append(option);
    }
    const append = document.createElement('option'); append.value = ''; append.textContent = text('last', 'Last'); control.append(append);
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
      option.textContent = item.member_ids.map(id => noteById.get(id)?.title).filter(Boolean).join(' · '); destination.append(option);
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
    if (!current() || !manageable || busy) return;
    try {
      if (kind === 'reorder' && moveSelectionBefore(source.member_ids, fields.selected_ids, fields.before_note_id).every((id, index) => id === source.member_ids[index])) {
        clearTools(); renderPages(); return;
      }
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
      if (card) return { kind: 'overview', group_id: currentGroup.id, before_note_id: Number(card.dataset.groupPage), valid };
      if (grid.contains(element)) return { kind: 'overview', group_id: currentGroup.id, before_note_id: null, valid };
      if (element.closest('button,input,select,summary,a')) return null;
      if (dragging && (element === overlay || element.closest('[data-group-exit]') || session.clientY < grid.getBoundingClientRect().top)) return { kind: 'exit' };
      return null;
    }
    if (canvasHitTest) {const target=canvasHitTest(session);return target?{...target,valid:target.valid&&allows('ungroup')&&(target.kind==='canvas'||allows('group'))}:null;}
    return canvasDrag ? { kind: 'canvas', valid: allows('ungroup') } : null;
  }
  function paintPreview({ state, session, target }) {
    if (!current()) return;
    highlightTarget(state === 'target-ready' && target?.kind === 'note' ? target.id : null);
    if (state === 'holding') activePointer = session.pointerId;
    if (state === 'dragging' && !dragging) {
      selected.clear(); session.selected_ids.forEach(id => selected.add(id)); selectionMode = true;
      // Retain the browser's original touch target while capture takes effect.
      grid.querySelectorAll('[data-group-page]').forEach(card => {
        const checked = selected.has(Number(card.dataset.groupPage));
        card.classList.toggle('is-selected', checked);
        const toggle = card.querySelector('[data-group-select]');
        if (toggle) { toggle.hidden = false; toggle.setAttribute('aria-pressed', String(checked)); toggle.textContent = checked ? '\u2713' : '\u25cb'; }
      });
      toolbar.querySelectorAll('button').forEach(control => { control.disabled = !selected.size || busy; });
      updateHeader();
    }
    dragging = !['holding', 'placement-choice', 'submitting'].includes(state);
    exit.hidden = !dragging;
    if (dragging) paintProxy(session); else clearProxy();
    if (dragging) suppressClick = true;
    exit.classList.toggle('is-dwelling', state === 'exit-dwell');
    overlay.dataset.gestureState = state;
    grid.querySelectorAll('[data-group-page]').forEach(card => card.classList.toggle('is-placeholder', dragging && session.selected_ids.includes(Number(card.dataset.groupPage))));
    if (state === 'destination-overview') {
      const destination = snapshot.groups.find(item => item.id === target.id && groupAllows(item,'group'));
      if (destination) { currentGroup = destination; overlay.hidden = false; renderPages(); }
    }
    if (dragging) startScroll(session);
  }
  function startScroll(session) {
    lastPoint = { x: session.clientX, y: session.clientY }; if (scrollFrame) return;
    const step = () => {
      scrollFrame = 0;
      if (closed || !dragging) return;
      const scroller = overlay.hidden ? host.querySelector('.notes-scroll') : grid;
      if (!scroller) return;
      const bounds = scroller.getBoundingClientRect(), edge = 36, speed = 12;
      const delta = (value, start, end) => value < start + edge ? -speed : value > end - edge ? speed : 0;
      scroller.scrollLeft = Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, scroller.scrollLeft + delta(lastPoint.x, Math.max(0, bounds.left), Math.min(innerWidth, bounds.right))));
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + delta(lastPoint.y, Math.max(0, bounds.top), Math.min(innerHeight, bounds.bottom))));
      scrollFrame = requestAnimationFrame(step);
    };
    scrollFrame = requestAnimationFrame(step);
  }
  const gesture = createNoteGroupGesture({ clientToWorld, hitTest, onPreview: paintPreview,
    onExit(session) { if (!current()) return; canvasDrag = true; overlay.hidden = true; stopScroll(); startScroll(session); onExitDrag(session); },
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
    onCancel() { activePointer = null; dragging = false; canvasDrag = false; exit.hidden = true; clearProxy(); stopScroll(); highlightTarget(null); if (!closed) { overlay.dataset.gestureState = 'idle'; currentGroup = source; overlay.hidden = false; renderPages(); } },
  });
  function pointerDown(event) {
    if (!current() || busy || dragPreview || standaloneIds.length) return;
    if (activePointer != null) { gesture.pointerDown(event); return; }
    // A new physical press is a new intent. The compatibility click belonging
    // to the previous released drag may have targeted the capture host instead.
    suppressClick = false;
    const activate = event.target.closest('[data-group-activate]');
    if (!activate || !overlay.contains(activate) || !(allows('move')||allows('ungroup')) || action) return;
    const id = Number(activate.dataset.groupActivate);
    // Keep the pressed DOM target alive until the browser has dispatched its
    // click; a short tap must still activate this page.
    const dragIds = selected.has(id) ? selection() : [id];
    let expected;
    try { expected = freezeNoteGroupCommand(draft, 'reorder', { group_id: source.id, selected_ids: dragIds, before_note_id: null }).expected; }
    catch (error) { announce(error.message); return; }
    gesture.pointerDown({ pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: event.isPrimary, button: event.button, clientX: event.clientX, clientY: event.clientY, currentTarget: host }, { selected_ids: dragIds, source_group_id: source.id, expected, can_manage: manageable });
  }
  function click(event) {
    if (!current()) return;
    if (suppressClick && event.detail !== 0) { suppressClick = false; event.preventDefault(); event.stopPropagation(); return; }
    const element = event.target.closest('button');
    if (event.target === overlay || element?.hasAttribute('data-group-close')) { close(); return; }
    if (!element || !overlay.contains(element)) return;
    if (element.hasAttribute('data-group-selection-mode')) { clearTools(); selectionMode = !selectionMode; if (!selectionMode) selected.clear(); renderPages(); mode.focus(); }
    else if (element.hasAttribute('data-group-activate')) { const id = Number(element.dataset.groupActivate); if (selectionMode && manageable && !dragPreview) updateSelection(id); else { close(); onActivate(id); } }
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
    if (event.key === 'Escape' && overlay.hidden) {
      event.preventDefault(); event.stopPropagation();
      gesture.pointerCancel('escape'); closeButton.focus(); return;
    }
    if (overlay.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      // The board remains the owner of a native drag and must receive Escape
      // after its destination preview closes.
      if (!dragPreview) event.stopPropagation();
      if (menu.open) { menu.open = false; menuToggle.focus(); }
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
    closed = true; clearProxy(); stopScroll(); highlightTarget(null); gesture.dispose(); subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
    overlay.remove(); if (overlayToken != null) dropOverlay(overlayToken);
    if (restore && restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true }); onClose();
  }
  function dispose() { close({ restore: false }); }
  function dragTarget(clientX, clientY) {
    if (!current() || overlay.hidden || !groupAllows(currentGroup,'group')) return null;
    const element = document.elementFromPoint(clientX, clientY);
    if (!element || !grid.contains(element)) return null;
    const card = element.closest('[data-group-page]');
    return { group_id: currentGroup.id, before_note_id: card ? Number(card.dataset.groupPage) : null };
  }
  function containsPoint(clientX, clientY) {
    return current() && !overlay.hidden && dialog.contains(document.elementFromPoint(clientX, clientY));
  }
  listen(window, 'pointerdown', pointerDown, true);
  listen(window, 'pointermove', event => { if (current()) gesture.pointerMove(event); }, { passive: false });
  listen(window, 'pointerup', event => { if (gesture.pointerUp(event)) suppressClick = true; if (activePointer === event.pointerId) activePointer = null; }, true);
  listen(window, 'pointercancel', event => gesture.pointerCancel(event));
  listen(host, 'lostpointercapture', event => gesture.pointerCancel(event));
  const resize = () => { gesture.pointerCancel('viewport-resize'); if (action) clearTools(); };
  listen(window, 'resize', resize);
  if (window.visualViewport) listen(window.visualViewport, 'resize', resize);
  listen(window, 'blur', () => gesture.pointerCancel('blur'));
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
  if (current() && manageable) {
    if (initialAction === 'order') orderSelection();
    else if (initialAction === 'move' || initialAction === 'add') moveSelection();
    else if (initialAction === 'remove') extractionChoices();
  }
  return { close, dispose, dragTarget, containsPoint };
}

/** One page-generation adapter. Native board drags retain their existing owner. */
export function createNoteGroupInteractions({ host, board, onCommand, onActivate = () => {}, authentication = {}, clientToWorld,
  onExitDrag, hitTest, onError = () => {}, clock = globalThis,
}) {
  const snapshot = structuredClone(board);
  let disposed = false, overview = null, preview = null, hover = null, hoverTimer = null, lastDrop = null, highlightedTarget = null;
  const current = () => !disposed && !authentication.signal?.aborted && authentication.isCurrent?.() !== false;
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
  function leaveTarget() {
    if (hoverTimer !== null) clock.clearTimeout(hoverTimer);
    hoverTimer = null; hover = null;
    highlightedTarget?.classList.remove('is-note-group-target'); highlightedTarget = null;
    const old = preview; preview = null; old?.dispose();
  }
  function clearOverview() { const old = overview; overview = null; old?.dispose(); }
  function emit(kind, fields) {
    if (!current()) return false;
    try {
      const command = freezeNoteGroupCommand(createNoteGroupDraft(snapshot, newNoteGroupOperationId()), kind, fields);
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
        group: { id: null, member_ids: [note.id], can_manage: true, permissions:note.permissions, layout: note.layout }, standaloneIds: [note.id], selectedIds: [note.id],
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
    if (hover?.item.key === item.key && hover.session.pointerId === session.pointerId && hover.session.item.key === session.item.key) { hover.session = session; return; }
    leaveTarget(); lastDrop = null;
    hover = { item, session, ready: false };
    const expectedHover = hover;
    hoverTimer = clock.setTimeout(() => {
      hoverTimer = null;
      if (!current() || hover !== expectedHover) return;
      hover.ready = true;
      if (item.kind === 'note') {
        highlightedTarget = host.querySelector(`[data-board-key="note:${item.id}"]`);
        highlightedTarget?.classList.add('is-note-group-target');
        return;
      }
      const group = snapshot.groups.find(group => group.id === item.id);
      preview = openNoteGroupOverview({ host, board: snapshot, notes: snapshot.notes, group, activeId: group.member_ids[0], dragPreview: session,
        authentication, onError, onClose: () => { preview = null; } });
    }, 400);
  }
  function targetAt(event, session) {
    if (!current() || !hover || hover.session.pointerId !== session.pointerId || hover.session.item.key !== session.item?.key) return null;
    return preview?.containsPoint(event.clientX, event.clientY) ? hover.item : null;
  }
  function dropTarget(item, session) {
    if (!current()) return true;
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
    disposed = true; leaveTarget(); clearOverview(); authentication.signal?.removeEventListener('abort', dispose);
  }
  authentication.signal?.addEventListener('abort', dispose, { once: true });
  return { onGroupAction, groupDragBridge: { hoverTarget, leaveTarget, dropTarget, targetAt }, dispose };
}
