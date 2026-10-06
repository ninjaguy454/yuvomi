import { memberLabel } from '/utils/member-label.js';
/**
 * Modul: Pinnwand / Notizen (Notes)
 * Zweck: Masonry-Grid mit farbigen Sticky Notes, Pin-Toggle, CRUD
 * Abhängigkeiten: /api.js, /router.js (window.yuvomi)
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, btnError, advancedSection, reportFieldError } from '/components/modal.js';
import { vibrate, scheduleUndoableDelete } from '/utils/ux.js';
import { t } from '/i18n.js';
import { esc, renderMarkdownLight } from '/utils/html.js';
import { splitKeepingLineEndings } from '/utils/markdown-checklist.js';
import { renderMarkdownToolbar, wireMarkdownToolbar } from '/utils/markdown-toolbar.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { findPageFab } from '/utils/fab.js';
import { emptyStateHTML } from '/utils/empty-state.js';
import { AVATAR_FALLBACK_COLOR } from '/utils/color.js';
import { renderAvatarStack } from '/components/user-multi-select.js';
import { getPermissions, moduleAccess, canCapability } from '/permissions.js';
import { authenticationSnapshot, sameAuthentication } from '/utils/device-context.js';
import { wireNoteBoard, renderNoteGroupFrame } from '/components/note-board.js';
import { createNoteGroupInteractions } from '/components/note-group-overview.js';
import { normalizeNoteLayout, organizeNoteGroupItems, projectNoteGroupItems, noteGroupArrangeItem } from '/utils/note-board-layout.js';
import { watchNoteChanges } from '/utils/note-live.js';
import { mountOpenTaskBoard } from '/components/open-task-board.js';
import { createNoteGroupDraft, freezeNoteGroupCommand, newNoteGroupOperationId } from '/utils/note-group-draft.js';
import {NOTE_LAYOUT_ACTIONS,deviceNoteAllows,noteItemAllows} from '/utils/note-permissions.js';

const NOTE_GROUPS_INTERFACE_ENABLED = true;

const canNote = action => getPermissions().principal_kind === 'device'
  ? moduleAccess('notes') !== 'none' && deviceNoteAllows(getPermissions().capabilities,action)
  : moduleAccess('notes') === 'write' || (action === 'view' && moduleAccess('notes') === 'read');
const canOnNote = (note, action) => canNote(action) && note?.permissions?.[action] !== false;
const canArrangeNote = note => canOnNote(note,'view') && canOnNote(note,'move') && note?.permissions?.arrange !== false;
const canArrangeItem = (note,item,action) => !boardIsFiltered() && canOnNote(note,'view') && canNote(action) && (item ? noteItemAllows(item,action) : canOnNote(note,action) && note?.permissions?.arrange!==false);
const boardIsFiltered = () => !!state.filterQuery.trim() || !!state.filterCreator;

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

// Gedämpfte Sticker-Palette. Die frühere Material-Primär-Palette
// (#FFEB3B/#80DEEA/#CE93D8 …) las wie eine billigere App (Critique P3).
// Seit dem HIG-Rollout tragen diese Werte die Karte nicht mehr als Vollfläche,
// sondern nur noch als 16-%-Tönung darauf (siehe .note-card in notes.css) -
// die Lesbarkeit hängt damit an keiner dieser Farben mehr, auch nicht an
// Alt-Hex-Werten ausserhalb der Palette. Die Palette bleibt trotzdem gedämpft:
// bei 16 % soll sie eine leise Ordnungshilfe sein, kein Signal.
const NOTE_COLORS = [
  '#EFE3BE', '#E7D2A9', '#D2DEC6', '#C7DED9',
  '#CAD8E4', '#D8D0E2', '#EBD1C2', '#FBFAF7',
];

const NOTE_COLOR_NAMES = () => ({
  '#EFE3BE': t('notes.colorYellow'),
  '#E7D2A9': t('notes.colorAmber'),
  '#D2DEC6': t('notes.colorGreen'),
  '#C7DED9': t('notes.colorTeal'),
  '#CAD8E4': t('notes.colorBlue'),
  '#D8D0E2': t('notes.colorPurple'),
  '#EBD1C2': t('notes.colorOrange'),
  '#FBFAF7': t('notes.colorWhite'),
});

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = { notes: [], groups: [], user: null, filterQuery: '', filterCreator: '', filterCreatorLabel: '' };
let _container = null;
let board = null;
let stopLive = null;
let stopOpenTasks = null;
const cardMarkup = new WeakMap();
const currentPage = (page, auth) => state === page && page.active && sameAuthentication(auth);
const boardSignature = value => JSON.stringify({ notes:value.notes.map(note=>[note.id,note.revision,note.layout,note.permissions]),groups:value.groups });
function normalizedBoard(value) {
  if (!Array.isArray(value?.notes) || !Array.isArray(value?.groups)) throw new Error('The Notes board response is incomplete. Reload it.');
  return NOTE_GROUPS_INTERFACE_ENABLED ? value : { notes:value.notes.map(note=>({...note,permissions:{...note.permissions,arrange:false}})),groups:[] };
}
function cancelGroupDrafts(page = state) {
  page.groupInteractions?.invalidateDraft();
  page.boardGeneration++;
  page.draftAbort.abort(); page.draftAbort = new AbortController();
  board?.cancel();
  if (document.querySelector('.note-modal[data-layout-editor]')) closeModal({ force:true });
}
function disposeGroupInteractions(page) {
  page.groupInteractions?.dispose(); page.groupInteractions = null;
  if (page.boardActions) { delete page.boardActions.onGroupAction; delete page.boardActions.groupDragBridge; }
}
function bindGroupInteractions() {
  const page = state, actions = page.boardActions;
  if (!NOTE_GROUPS_INTERFACE_ENABLED) return;
  const host = _container.querySelector('.notes-page'), authentication = actions.authentication;
  const context = {
    host, board: { notes: page.notes, groups: page.groups }, authentication,
    viewAuthentication: { signal: page.requests.signal, isCurrent: () => currentPage(page, page.auth) },
    canStartLayout: () => !boardIsFiltered() && canBeginLayout(page),
    filtered: boardIsFiltered(), activePages: page.activePages,
    onCommand: actions.submitGroupCommand,
    onError: error => { if (authentication.isCurrent() && !error.groupCommandHandled) layoutStatus(error.message || t('notes.layoutFailed')); },
    clientToWorld: (x, y) => board?.clientToWorld(x, y),
    hitTest: session => {
      if (!authentication.isCurrent() || boardIsFiltered()) return null;
      const element = document.elementFromPoint(session.clientX, session.clientY);
      if (!element || !host.querySelector('.notes-scroll')?.contains(element)) return null;
      const key = element.closest('.note-card')?.dataset.boardKey;
      const item = key && visibleBoardItems().find(item => item.key === key);
      if (item) {
        const valid = noteItemAllows(item,'group') && (item.kind === 'group' || item.layout.position_locked);
        return { kind: item.kind, id: item.id, valid };
      }
      // List coordinates describe its packed reading order, not world placement.
      return host.querySelector('#notes-grid')?.dataset.boardView === 'canvas' ? { kind: 'canvas', valid: true } : null;
    },
    onActivate: (noteId, groupId) => {
      if (!authentication.isCurrent()) return;
      page.activePages.set(groupId, noteId); renderGrid();
      _container.querySelector(`[data-board-key="group:${groupId}"] [data-group-page="overview"]`)?.focus({ preventScroll: true });
    },
  };
  const interactions = page.groupInteractions || createNoteGroupInteractions(context);
  if (page.groupInteractions) interactions.update(context);
  page.groupInteractions = interactions;
  interactions.setWriteState(page.groupFeedback || { phase: layoutWriteState(page) });
  actions.onGroupAction = interactions.onGroupAction; actions.groupDragBridge = interactions.groupDragBridge;
}
function acceptBoardView(value) {
  const fresh = normalizedBoard(value), page = state;
  const lostAccess = page.notes.some(note => {
    const next = fresh.notes.find(value=>value.id===note.id);
    return !next || ['view','edit','delete','manage_visibility',...NOTE_LAYOUT_ACTIONS].some(action=>note.permissions?.[action]===true && next.permissions?.[action]!==true);
  });
  if (lostAccess) { page.accessGeneration++; page.groupRetry=null; page.groupUndo=null; }
  const changed = boardSignature(page) !== boardSignature(fresh);
  if (changed) page.groupUndo=null;
  page.notes = fresh.notes.filter(note=>!page.deleting.has(note.id)); page.groups = fresh.groups;
  for (const [id,member] of page.activePages) if (!page.groups.some(group=>group.id===id && group.member_ids.includes(member))) page.activePages.delete(id);
  return { fresh, changed, lostAccess };
}
function bindGroupCommands() {
  const page = state, signature = boardSignature(page) + JSON.stringify([page.filterQuery,page.filterCreator]);
  if (page.renderSignature !== undefined && page.renderSignature !== signature) cancelGroupDrafts(page);
  page.renderSignature = signature;
  const auth = page.auth, generation = page.boardGeneration;
  const isCurrent = () => currentPage(page,auth) && page.boardGeneration===generation;
  const draft = createNoteGroupDraft({notes:page.notes,groups:page.groups},newNoteGroupOperationId());
  page.boardActions = { ...page.boardActions,
    authentication:{signal:page.draftAbort.signal,isCurrent},
    submitGroupCommand: command => {
      if (!isCurrent() || boardIsFiltered()) return Promise.reject(new Error(t('notes.layoutConflict')));
      return submitGroupCommand(command);
    },
    saveBoardCommand: async input => {
      if (!NOTE_GROUPS_INTERFACE_ENABLED || !isCurrent() || boardIsFiltered() || !canBeginLayout(page)) return false;
      try {
        const {kind,...fields}=input;
        return await submitGroupCommand(freezeNoteGroupCommand(draft,kind,fields));
      } catch (error) {
        if (currentPage(page,auth) && !error.groupCommandHandled) layoutStatus(error.message || t('notes.layoutFailed'));
        return false;
      }
    },
  };
}

// --------------------------------------------------------
// Antippbare Checklisten (#704)
// --------------------------------------------------------

// Die Notizen sind die eine Stelle, die einen Haken auch zurueckschreiben kann:
// sie zeigen den vollstaendigen Text und kennen die Notiz-ID. Das Dashboard
// bekommt diese Optionen deshalb ausdruecklich nicht - dort steht ein gekuerzter
// Auszug, dessen Zeilennummern nicht die der Notiz sind.
const CHECKLIST_OPTS = (note) => ({
  checklist: { interactive: canOnNote(note, 'edit'), toggleLabel: t('notes.checklistToggle') },
});

/**
 * Zeichnet einen umgeschalteten Haken in jede Ansicht, die ihn gerade zeigt.
 *
 * Optimistic painting leaves the card connected. After acknowledgment,
 * reconciliation also retains it while refreshing the revision-bound layout
 * commands; `state.notes` is not reordered until the next full reload.
 */
function paintCheck(noteId, line, checked) {
  const card = _container?.querySelector(`.note-card[data-id="${noteId}"]`);
  const markup = cardMarkup.get(card);
  const cached = markup ? document.createElement('template') : null;
  if (cached) cached.innerHTML = markup;
  const roots = [
    card?.querySelector('.note-card__content'),
    document.querySelector(`.note-modal[data-note-id="${noteId}"] .note-read__body`),
    cached?.content.querySelector('.note-card__content'),
  ];
  for (const root of roots) {
    const box = root?.querySelector(`.note-md-box[data-md-line="${line}"]`);
    if (!box) continue;
    box.setAttribute('aria-checked', String(checked));
    box.dataset.mdChecked = checked ? '1' : '0';
    box.closest('.note-md-check')?.classList.toggle('is-checked', checked);
  }
  // The cache describes the displayed card, including optimistic checks and
  // their rollback. Otherwise a later remote reversal could match stale HTML,
  // or a geometry-only acknowledgment could replace a current, focused card.
  if (cached) cardMarkup.set(card, cached.innerHTML);
}

/**
 * Haken setzen oder loesen.
 *
 * Optimistisch: der Haken erscheint sofort, denn auf dem Wandtablett ist das
 * die ganze Interaktion, und eine Verzoegerung dort laesst sie kaputt aussehen.
 * Schlaegt die Anfrage fehl, geht er zurueck - inklusive des Falls, dass
 * jemand anders den Text inzwischen bearbeitet hat (409). Dann wird neu
 * geladen, statt einen Haken zu behaupten, den der Server nicht kennt.
 */
async function toggleCheck(noteId, box) {
  if (!canNote('edit')) return;
  const note = state.notes.find((n) => n.id === noteId);
  if (!note || !canOnNote(note, 'edit')) return;
  const page = state, auth = authenticationSnapshot();

  const line    = parseInt(box.dataset.mdLine, 10);
  const checked = box.dataset.mdChecked !== '1';
  // Die Zeile, die der Nutzer gesehen hat - sie ist die Gegenprobe zum Index.
  const expect  = splitKeepingLineEndings(note.content)[line * 2];

  // Der eigene Stand kennt die angetippte Zeile gar nicht mehr: dasselbe
  // Ergebnis wie ein 409, nur ohne den Umweg ueber den Server - und
  // ausdruecklich nicht stilles Nichtstun, sonst taete ein Tap einfach nichts.
  if (expect === undefined) {
    await handleCheckConflict();
    return;
  }

  paintCheck(noteId, line, checked);
  vibrate(10);

  try {
    const res = await api.patch(`/notes/${noteId}/check`, { line, checked, expect });
    if (!currentPage(page, auth)) return;
    // A refresh or permission change may have replaced this note while the
    // check was in flight. Reload canonical state rather than painting an old
    // response onto its replacement.
    if (!page.notes.includes(note)) { await reloadNotes(); return; }
    note.content = res.data.content;
    note.updated_at = res.data.updated_at;
    note.revision = res.data.revision ?? note.revision;
    renderGrid();
  } catch (err) {
    if (!currentPage(page, auth)) return;
    if (!page.notes.includes(note)) { await reloadNotes(); return; }
    paintCheck(noteId, line, !checked);
    if (err.status === 409) {
      await handleCheckConflict();
    } else {
      window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    }
  }
}

async function handleCheckConflict() {
  window.yuvomi?.showToast(t('notes.checkConflict'), 'danger');
  await reloadNotes();
}

// --------------------------------------------------------
// Entry Point
// --------------------------------------------------------

export async function render(container, { user }) {
  board?.destroy(); stopLive?.(); stopOpenTasks?.();
  if (state) { state.active = false; state.requests?.abort(); state.draftAbort?.abort(); disposeGroupInteractions(state); }
  _container = container;
  state = { notes: [], groups: [], activePages:new Map(), user, filterQuery: '', filterCreator: '', filterCreatorLabel: '', compact: false, active: true, listDensity: 'expanded', expandedNotes: new Set(), pending: new Set(), deleting: new Set(), viewport: {}, requests:new AbortController(), draftAbort:new AbortController(), boardGeneration:0, accessGeneration:0 };
  const pageState = state;
  const auth = authenticationSnapshot();
  pageState.auth = auth;
  const clearNotes = () => { if (state === pageState) { state.active = false; state.requests.abort(); state.draftAbort.abort(); disposeGroupInteractions(state); state.notes = []; state.groups=[]; state.activePages.clear(); state.groupRetry=null; state.groupUndo=null; state.pending.clear(); state.expandedNotes.clear(); board?.destroy(); board = null; stopLive?.(); stopLive = null; stopOpenTasks?.(); stopOpenTasks = null; container.replaceChildren(); closeModal({ force: true }); } };
  const contextChanged = () => { if (!sameAuthentication(auth)) clearNotes(); };
  window.addEventListener('auth:context-ending', clearNotes, { once: true });
  window.addEventListener('auth:expired', clearNotes, { once: true });
  window.addEventListener('auth:context-rejected', clearNotes, { once: true });
  window.addEventListener('vidamia:auth-context', contextChanged);

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="notes-page">
      <div class="page-toolbar notes-toolbar">
        <h1 class="page-toolbar__title">${t('notes.title')}</h1>
        <div class="notes-header-actions" id="notes-header-actions">
          <button type="button" class="btn btn--ghost btn--icon" id="notes-compact-view" aria-label="${t('notes.compactView')}" title="${t('notes.compactView')}" aria-pressed="false"><i data-lucide="list" class="icon-md" aria-hidden="true"></i></button>
          ${canNote('view') && canNote('move') ? `<button type="button" class="btn btn--ghost btn--icon" id="notes-organize" aria-label="${t('notes.organize')}" title="${t('notes.organize')}"><i data-lucide="layout-grid" class="icon-md" aria-hidden="true"></i></button><label id="notes-include-locked" class="btn btn--ghost btn--icon notes-include-locked" title="${t('notes.organize')}: ${t('notes.includeLocked')}"><input type="checkbox" id="notes-organize-locked" aria-label="${t('notes.organize')}: ${t('notes.includeLocked')}"><i data-lucide="pin" class="icon-md" aria-hidden="true"></i></label>` : ''}
        </div>
        ${renderPageSearch({ id: 'notes-search', label: t('notes.searchPlaceholder'), placeholder: t('notes.searchPlaceholder'), value: state.filterQuery, clearLabel: t('common.searchClear'), className: 'notes-toolbar__search' })}
        <button class="btn btn--primary toolbar-new-btn" id="notes-add-btn" aria-label="${t('notes.addNoteLabel')}">
          <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
          <span class="toolbar-new-btn__label">${t('newLabel.notes')}</span>
        </button>
      </div>
      <div class="notes-board-toolbar">
        <div class="notes-filters" id="notes-filters" role="group" aria-label="${t('notes.filterCreatorLabel')}" hidden></div>
        <label class="notes-list-density" id="notes-list-density-label" hidden><span class="sr-only">${t('notes.listDensity')}</span>
          <select id="notes-list-density"><option value="compact">${t('notes.listCompact')}</option><option value="expanded" selected>${t('notes.listExpanded')}</option></select>
        </label>
        <div class="notes-zoom-controls" id="notes-zoom-controls" hidden>
          <button type="button" class="btn btn--ghost btn--icon" id="notes-zoom-out" aria-label="${t('notes.zoomOut')}" title="${t('notes.zoomOut')}"><i data-lucide="minus" class="icon-md" aria-hidden="true"></i></button><output id="notes-zoom-value">100%</output>
          <button type="button" class="btn btn--ghost btn--icon" id="notes-zoom-in" aria-label="${t('notes.zoomIn')}" title="${t('notes.zoomIn')}"><i data-lucide="plus" class="icon-md" aria-hidden="true"></i></button>
          <button type="button" class="btn btn--ghost btn--icon" id="notes-reset-view" aria-label="${t('notes.resetView')}" title="${t('notes.resetView')}"><i data-lucide="rotate-ccw" class="icon-md" aria-hidden="true"></i></button>
          <button type="button" class="btn btn--ghost btn--icon" id="notes-snap-to-grid" aria-label="${t('notes.snapToGrid')}" title="${t('notes.snapToGrid')}" aria-pressed="false"><i data-lucide="grid-2x2" class="icon-md" aria-hidden="true"></i></button>
        </div>
        <div class="notes-board-feedback"><span id="notes-board-status" class="notes-board-status" role="status" aria-live="polite"></span></div>
      </div>
      <div class="notes-reveal-strip" role="group" aria-label="${t('notes.revealOverlapping')}" hidden></div>
      <div class="notes-workspace">
        <aside id="notes-open-tasks" class="notes-open-tasks" hidden></aside>
        <div class="notes-scroll page-scrollport">
          <div class="notes-canvas-space"><div id="notes-grid" class="notes-grid" aria-busy="true">${renderSkeletonList({ rows: 5, lines: 3 })}</div></div>
        </div>
      </div>
      <button class="page-fab" id="fab-new-note" aria-label="${t('notes.addNoteLabel')}" data-dock-label="${t('newLabel.notes')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
      </button>
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: container });
  stopOpenTasks = mountOpenTaskBoard(container.querySelector('#notes-open-tasks'), { user });

  try {
    const res  = canNote('view') ? await api.get('/notes/board',{signal:pageState.requests.signal,requireFresh:true}) : { data:{notes:[],groups:[]} };
    if (!currentPage(pageState, auth)) return () => {};
    acceptBoardView(res.data);
  } catch (err) {
    if (!currentPage(pageState, auth)) return () => {};
    console.error('[Notes] Laden fehlgeschlagen:', err);
    throw err;
  }
  const grid = container.querySelector('#notes-grid');
  grid.addEventListener('click', async (e) => {
    const expand = e.target.closest('[data-note-expand]');
    if (expand) {
      e.stopPropagation();
      const id = Number(expand.closest('.note-card').dataset.id);
      const note = state.notes.find(note => note.id === id);
      if (!state.active || !note || !canOnNote(note, 'view')) return;
      if (state.expandedNotes.has(id)) state.expandedNotes.delete(id); else state.expandedNotes.add(id);
      renderGrid();
      return;
    }
    if (e.target.closest('a, summary')) { e.stopPropagation(); return; }
    const adjust = e.target.closest('[data-board-action="adjust"]');
    if (adjust) {
      e.stopPropagation(); const card=adjust.closest('.note-card');
      openLayoutModal(Number(card.dataset.groupId || card.dataset.id),card.dataset.groupId?'group':'note'); return;
    }
    const flagButton = e.target.closest('[data-board-action="lock"], [data-board-action="top"]');
    if (flagButton) {
      e.stopPropagation();
      const note = state.notes.find(n => n.id === Number(flagButton.closest('.note-card').dataset.id));
      const flag = flagButton.dataset.boardAction === 'lock' ? 'position_locked' : 'always_on_top';
      if (note && await saveLayoutChange(note, { [flag]: !note.layout?.[flag] })) renderGrid();
      return;
    }
    const pinBtn = e.target.closest('[data-action="pin"]');
    if (pinBtn) { e.stopPropagation(); await togglePin(parseInt(pinBtn.dataset.id, 10)); return; }

    const delBtn = e.target.closest('[data-action="delete"]');
    if (delBtn) { e.stopPropagation(); await deleteNote(parseInt(delBtn.dataset.id, 10)); return; }

    // Ein Haken auf der Karte darf die Notiz nicht oeffnen (#704) - sonst
    // schluege der Zettel bei jedem Abhaken auf, und genau die drei Schritte
    // sollten ja wegfallen.
    const box = e.target.closest('.note-md-box[data-md-line]');
    if (box) {
      e.stopPropagation();
      const owner = box.closest('.note-card[data-id]');
      if (owner) await toggleCheck(parseInt(owner.dataset.id, 10), box);
      return;
    }

    // [data-action="open"] fällt bewusst durch auf den Karten-Zweig darunter —
    // der Button liegt in der Karte, ein Treffer reicht.
    const card = e.target.closest('.note-card[data-id]');
    if (card) {
      if (!window.getSelection()?.isCollapsed) return;
      const note = state.notes.find((n) => n.id === parseInt(card.dataset.id, 10));
      if (note) openNoteModal({ mode: 'edit', note });
    }
  });

  renderCreatorFilter();
  renderGrid();
  if (canNote('view')) stopLive = watchNoteChanges(reloadNotes);
  container.querySelector('#notes-compact-view').addEventListener('click', e => {
    state.compact = !state.compact; e.currentTarget.setAttribute('aria-pressed', String(state.compact)); renderGrid();
  });
  container.querySelector('#notes-list-density').addEventListener('change', e => {
    state.listDensity = e.currentTarget.value === 'compact' ? 'compact' : 'expanded'; renderGrid();
  });
  container.querySelector('#notes-organize')?.addEventListener('click', organizeNotes);
  container.querySelector('#notes-zoom-in').addEventListener('click', () => board?.zoomBy(.25));
  container.querySelector('#notes-zoom-out').addEventListener('click', () => board?.zoomBy(-.25));
  container.querySelector('#notes-reset-view').addEventListener('click', () => board?.resetView());
  container.querySelector('#notes-snap-to-grid').addEventListener('click', e => {
    state.viewport.snapToGrid = !state.viewport.snapToGrid;
    e.currentTarget.setAttribute('aria-pressed', String(state.viewport.snapToGrid));
    board?.setSnapToGrid(state.viewport.snapToGrid);
  });

  if (!canNote('create')) {
    _container.querySelector('#notes-add-btn')?.remove();
    findPageFab('fab-new-note')?.remove();
  }

  const addHandler = () => openNoteModal({ mode: 'create' });
  // #notes-add-btn ist per .toolbar-new-btn global ausgeblendet (FAB übernimmt),
  // bleibt aber als einheitliches Modul-Muster erhalten (frontend-audit 1.9).
  _container.querySelector('#notes-add-btn')?.addEventListener('click', addHandler);
  findPageFab('fab-new-note')?.addEventListener('click', addHandler);

  wirePageSearch(_container, {
    id: 'notes-search',
    delay: 0,
    onQuery: (value) => {
      state.filterQuery = value;
      renderGrid();
    },
  });
  return () => { window.removeEventListener('auth:context-ending', clearNotes); window.removeEventListener('auth:expired', clearNotes); window.removeEventListener('auth:context-rejected', clearNotes); window.removeEventListener('vidamia:auth-context', contextChanged); clearNotes(); };
}

// --------------------------------------------------------
// Grid
// --------------------------------------------------------

/**
 * Ersteller-Filterzeile. Erst ab zwei Autorinnen/Autoren sinnvoll — in einem
 * Ein-Personen-Haushalt wäre sie ein Chip ohne Alternative. Nutzt dieselben
 * Button-Chips wie Dokumente/Aufgaben (Tastatur + aria-pressed).
 */
function creatorFilterKey(note) {
  if (note.created_by != null) return `member:${note.created_by}`;
  if (note.created_by_device != null) return `device:${note.created_by_device}`;
  return `name:${note.creator_name || ''}`;
}

function renderCreatorFilter() {
  const row = _container.querySelector('#notes-filters');
  if (!row) return;

  const creators = [...new Map(
    state.notes
      .filter((n) => n.creator_name)
      .map((n) => [creatorFilterKey(n), n])
  ).values()];

  const focusedCreator = row.contains(document.activeElement) ? document.activeElement.dataset.creator : undefined;
  const scrollLeft = row.scrollLeft;
  row.hidden = creators.length < 2;
  row.replaceChildren();
  if (row.hidden) return;

  const makeChip = (label, value, visual) => {
    const active = state.filterCreator === value;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `filter-chip filter-chip--sm notes-creator-chip${active ? ' filter-chip--active' : ''}`;
    chip.dataset.creator = value;
    chip.setAttribute('aria-pressed', String(active));
    chip.setAttribute('aria-label', label);
    chip.title = label;
    chip.innerHTML = `<span aria-hidden="true">${visual}</span>`;
    return chip;
  };

  row.appendChild(makeChip(t('common.all'), '', '<i data-lucide="users" class="icon-md"></i>'));
  creators.forEach((n) => {
    const author = { id: n.created_by, display_name: n.creator_name, color: n.creator_color, avatar_data: n.creator_avatar };
    const visual = n.created_by == null && n.created_by_device != null
      ? '<i data-lucide="monitor" class="icon-md"></i>'
      : renderAvatarStack([author], { size: 28 });
    row.appendChild(makeChip(memberLabel(author), creatorFilterKey(n), visual));
  });
  if (window.lucide) lucide.createIcons({ el: row });
  row.scrollLeft = scrollLeft;
  if (focusedCreator !== undefined) {
    const focused = [...row.children].find(chip => chip.dataset.creator === focusedCreator);
    focused?.focus({ preventScroll: true });
    focused?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  row.querySelectorAll('[data-creator]').forEach((chip) => {
    chip.addEventListener('click', () => {
      // Erneuter Klick auf den aktiven Chip hebt den Filter auf.
      state.filterCreator = state.filterCreator === chip.dataset.creator ? '' : chip.dataset.creator;
      state.filterCreatorLabel = state.filterCreator ? chip.getAttribute('aria-label') : '';
      renderCreatorFilter();
      renderGrid();
    });
  });
}

function visibleNotes() {
  const q = state.filterQuery.trim().toLowerCase();
  return state.notes.filter((n) => {
    if (state.filterCreator && creatorFilterKey(n) !== state.filterCreator) return false;
    if (!q) return true;
    return (n.title   || '').toLowerCase().includes(q)
        || (n.content || '').toLowerCase().includes(q);
  });
}

function visibleBoardItems() {
  state.activePages ||= new Map();
  return projectNoteGroupItems({notes:visibleNotes(),groups:state.groups || []}, {
    activePages:state.activePages,filtered:!!state.filterQuery.trim() || !!state.filterCreator,
  });
}

function boardOptions() {
  const page = state;
  return { getNotes:visibleNotes,getBoardItems:visibleBoardItems,activePages:state.activePages,
    canStartLayout:()=>canBeginLayout(page),
    pendingLayouts:page.pendingLayouts ||= new Map(),
    onLayoutSettled:()=>{if(page.active && state===page)board?.refresh();},
    canEdit:canArrangeNote,saveLayout,viewState:state.viewport,
    getResponsiveWidth:()=>_container.querySelector('.notes-page').clientWidth,
    saveBoardCommand:state.boardActions?.saveBoardCommand,groupDragBridge:state.boardActions?.groupDragBridge,
    onGroupAction:(action,item)=>state.boardActions?.onGroupAction?.(action,item),
    compact:state.listView,filtered:!!state.filterQuery.trim() || !!state.filterCreator,onViewChange:renderGrid };
}

function renderGrid() {
  if (!state.active) return;
  bindGroupCommands();
  const grid = _container.querySelector('#notes-grid');
  if (!grid) return;
  const focused = document.activeElement?.closest('.note-card');
  const focusId = focused?.dataset.id;
  const focusAction = document.activeElement?.dataset.action;
  const focusBoardAction = document.activeElement?.dataset.boardAction;
  const focusExpand = document.activeElement?.hasAttribute('data-note-expand');
  const focusChecklistLine = document.activeElement?.dataset.mdLine;
  const previewScroll = new Map([...grid.querySelectorAll('.note-card')].map(card => [card.dataset.id, card.querySelector('.note-card__content')?.scrollTop || 0]));
  board?.destroy({ preserveReveal:true }); board = null;
  bindGroupInteractions();
  syncLayoutWriteState();

  const q = state.filterQuery.trim().toLowerCase();
  const visible = visibleNotes();
  const forceCompact = state.notes.some(note => note.layout?.overflow);
  // A companion Tasks rail reduces the canvas, not the device's available page width.
  const phoneWidth = _container.querySelector('.notes-page').clientWidth < 640;
  state.listView = state.compact || forceCompact || phoneWidth;
  grid.dataset.boardView = state.listView ? 'list' : 'canvas';
  grid.dataset.listDensity = state.listDensity;
  _container.querySelector('#notes-list-density-label').hidden = !state.listView;
  _container.querySelector('#notes-list-density').value = state.listDensity;
  const organizeButton = _container.querySelector('#notes-organize');
  if (organizeButton) { organizeButton.hidden = state.listView || boardIsFiltered() || !NOTE_GROUPS_INTERFACE_ENABLED; organizeButton.disabled = !!layoutWriteState(); }
  const includeLocked = _container.querySelector('#notes-include-locked');
  if (includeLocked) includeLocked.hidden = state.listView || boardIsFiltered() || !NOTE_GROUPS_INTERFACE_ENABLED;
  _container.querySelector('#notes-zoom-controls').hidden = state.listView;
  for (const id of state.expandedNotes) if (!state.notes.some(note => note.id === id && canOnNote(note, 'view'))) state.expandedNotes.delete(id);
  const compactButton = _container.querySelector('#notes-compact-view');
  if (compactButton) {
    compactButton.hidden = phoneWidth;
    compactButton.disabled = forceCompact;
    compactButton.setAttribute('aria-pressed', String(state.listView));
    const destination = t(state.listView ? 'notes.canvasView' : 'notes.compactView');
    compactButton.setAttribute('aria-label', destination);
    compactButton.title = destination;
    compactButton.innerHTML = `<i data-lucide="${state.listView ? 'panels-top-left' : 'list'}" class="icon-md" aria-hidden="true"></i>`;
    if (window.lucide) lucide.createIcons({ el: compactButton });
  }
  _container.querySelector('#notes-header-actions').hidden = phoneWidth || forceCompact;

  if (!visible.length) {
    const isFiltered = q.length > 0 || !!state.filterCreator;
    grid.replaceChildren();
    // Gefiltert ohne Treffer ist ein anderer Zustand als „noch keine Notiz":
    // er wird als `role="status"` angesagt und traegt keinen Anlegen-CTA.
    grid.insertAdjacentHTML('beforeend', isFiltered
      ? emptyStateHTML({
        variant: 'no-results',
        title: t('notes.noResultsTitle'),
        description: q
          ? t('notes.noResultsDescription', { query: state.filterQuery })
          : t('notes.noResultsCreatorDescription', { name: state.filterCreatorLabel }),
      })
      : emptyStateHTML({
        icon: 'file-text',
        title: t('notes.emptyTitle'),
        description: t('notes.emptyDescription'),
        hint: t('emptyHint.notes'),
        action: canNote('create') ? { label: t('notes.emptyAction'), icon: 'plus', attrs: { id: 'empty-cta-notes' } } : undefined,
      }));
    if (window.lucide) lucide.createIcons({ el: grid });
    grid.querySelector('#empty-cta-notes')?.addEventListener('click', () => {
      document.querySelector('.page-fab')?.click();
    });
    visibleBoardItems();
    board = wireNoteBoard(grid, boardOptions());
    return;
  }

  // Angepinnte Notizen standen schon immer vorn, aber ohne sichtbare Grenze:
  // die Trennung war nur aus dem Ring an der Karte zu erschließen. Zwei
  // Abschnittsköpfe machen die bestehende Sortierung lesbar. Sie erscheinen
  // nur, wenn es tatsächlich beide Gruppen gibt.
  // Geometry acknowledgments do not change a card's contents. Keep those nodes
  // connected so preview scroll, focus and open menus survive a layout save.
  const projected = visibleBoardItems(), keys = new Set(projected.map(item=>item.key));
  for (const card of [...grid.children]) if (!keys.has(card.dataset.boardKey)) card.remove();
  const existing = new Map([...grid.children].map(card => [card.dataset.boardKey,card]));
  const retained = new Set();
  let index = 0, needsIcons = false;
  for (const item of projected) {
    const html = renderNoteGroupFrame(item,renderNoteCard(item.note,item));
    let card = existing.get(item.key);
    if (!card || cardMarkup.get(card) !== html) {
      const template = document.createElement('template'); template.innerHTML = html;
      const replacement = template.content.firstElementChild;
      if (card) card.replaceWith(replacement);
      card = replacement; cardMarkup.set(card,html); needsIcons = true;
    }
    retained.add(card);
    if (grid.children[index] !== card) grid.insertBefore(card,grid.children[index] || null);
    index++;
  }
  for (const card of [...grid.children]) if (!retained.has(card)) card.remove();
  // The bundled Lucide version scans the connected document, not detached el.
  if (needsIcons && window.lucide) lucide.createIcons({ el: grid });
  board = wireNoteBoard(grid, boardOptions());
  if (focusId && focusAction) grid.querySelector(`.note-card[data-id="${focusId}"] [data-action="${focusAction}"]`)?.focus({ preventScroll: true });
  if (focusId && focusBoardAction) grid.querySelector(`.note-card[data-id="${focusId}"] [data-board-action="${focusBoardAction}"]`)?.focus({ preventScroll: true });
  if (focusId && focusExpand) grid.querySelector(`.note-card[data-id="${focusId}"] [data-note-expand]`)?.focus({ preventScroll: true });
  if (focusId && focusChecklistLine !== undefined) grid.querySelector(`.note-card[data-id="${focusId}"] .note-md-box[data-md-line="${focusChecklistLine}"]`)?.focus({ preventScroll: true });
  for (const [id, top] of previewScroll) {
    const preview = grid.querySelector(`.note-card[data-id="${id}"] .note-card__content`);
    if (preview) preview.scrollTop = top;
  }
}

// Truncate the safe rendered DOM, not Markdown source: retained links and checklist
// buttons keep their original source-line indices, without hidden trailing content.
function listPreview(note, expanded) {
  const html = renderMarkdownLight(note.content, CHECKLIST_OPTS(note));
  const template = document.createElement('template');
  template.innerHTML = html;
  const truncated = [...template.content.textContent].length > 200;
  if (!truncated || expanded) return { html, truncated };
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  let remaining = 199, node;
  while ((node = walker.nextNode())) {
    const chars = [...node.textContent];
    if (chars.length <= remaining) { remaining -= chars.length; continue; }
    const prefix = chars.slice(0, remaining).join('');
    const range = document.createRange();
    range.setStart(node, prefix.length);
    range.setEnd(template.content, template.content.childNodes.length);
    range.deleteContents();
    node.textContent = prefix + '…';
    break;
  }
  // A checklist's accessible name must not disclose the omitted part of its line.
  for (const box of template.content.querySelectorAll('button.note-md-box')) {
    box.setAttribute('aria-label', box.closest('.note-md-check')?.textContent || t('notes.checklistToggle'));
  }
  return { html: template.innerHTML, truncated };
}

function renderBoardMenu(note, item) {
  if (!canOnNote(note, 'edit') && !canOnNote(note, 'delete') && !NOTE_LAYOUT_ACTIONS.some(action=>canArrangeItem(note,item,action))) return '';
  const layout=item?.layout || note.layout;
  const manage=canArrangeItem(note,item,'move'),group=canArrangeItem(note,item,'group'),ungroup=canArrangeItem(note,item,'ungroup');
  return `<details class="note-card__menu" data-board-menu>
    <summary aria-label="${t('notes.cardMenu')}"><i data-lucide="ellipsis" class="icon-sm" aria-hidden="true"></i></summary>
    <div class="note-card__menu-items">
      ${canOnNote(note, 'edit') ? `<button type="button" data-action="pin" data-id="${note.id}" aria-pressed="${!!note.pinned}"><span aria-hidden="true">${note.pinned ? '✓' : ''}</span><span>${t('notes.showOnDashboard')}</span></button>` : ''}
      ${manage ? `<button type="button" data-board-action="top" aria-pressed="${!!layout?.always_on_top}"><span aria-hidden="true">${layout?.always_on_top ? '✓' : ''}</span><span>${t('notes.alwaysOnTop')}</span></button>` : ''}
      ${manage && item?.kind==='group' ? `<button type="button" data-board-action="adjust"><span aria-hidden="true"></span><span>${t('notes.adjustCard')}</span></button>` : ''}
      ${state.boardActions?.onGroupAction ? (item?.kind==='group'
        ? [['move',group&&ungroup],['remove',ungroup],['order',manage]].filter(([,allowed])=>allowed).map(([action])=>`<button type="button" data-group-action="${action}"><span aria-hidden="true"></span><span>${t(`notes.groupAction.${action}`)}</span></button>`).join('')
        : group?`<button type="button" data-group-action="add"><span aria-hidden="true"></span><span>${t('notes.groupAction.add')}</span></button>`:'') : ''}
      ${canOnNote(note, 'delete') ? `<button type="button" data-action="delete" data-id="${note.id}"><span aria-hidden="true"></span><span>${t('notes.deleteLabel')}</span></button>` : ''}
    </div>
  </details>`;
}

function renderPositionControls(note, item) {
  return `${canArrangeItem(note,item,'pin')?`<button type="button" class="note-card__lock" data-board-action="lock" aria-label="${t('notes.positionLock')}" aria-pressed="${!!(item?.layout || note.layout)?.position_locked}"><span class="note-card__badge-art" aria-hidden="true"><i data-lucide="pin" class="icon-sm"></i></span></button>`:''}
    ${canArrangeItem(note,item,'move')?`<button type="button" class="note-card__adjust" data-board-action="adjust">${t('notes.adjustCard')}</button>`:''}`;
}

function renderNoteTitle(note) {
  return `<button type="button" class="note-card__title" data-action="open" data-id="${note.id}">${esc(note.title?.trim() || t('notes.untitledNote'))}</button>`;
}

function renderListCard(note, item) {
  const compact = state.listDensity === 'compact';
  const expanded = state.expandedNotes.has(note.id);
  const preview = compact ? null : listPreview(note, expanded);
  return `<div class="note-card note-card--list ${note.pinned ? 'note-card--pinned' : ''}" data-id="${note.id}" style="--note-color:${esc(note.color)};">
    <div class="note-card__list-heading">
      ${renderPositionControls(note,item)}
      ${renderNoteTitle(note)}
      ${renderBoardMenu(note,item)}
    </div>
    ${compact ? '' : `<div class="note-card__preview"><div class="note-card__content" id="note-list-body-${note.id}">${preview.html}</div>
      ${preview.truncated ? `<button type="button" class="note-card__expand" data-note-expand aria-expanded="${expanded}" aria-controls="note-list-body-${note.id}">${t(expanded ? 'notes.showLess' : 'notes.showMore')}</button>` : ''}</div>
      <div class="note-card__list-meta">${esc(memberLabel({ id: note.created_by, display_name: note.creator_name }))}</div>`}
  </div>`;
}

function renderNoteCard(note, item) {
  if (state.listView) return renderListCard(note,item);
  // KEINE INITIALEN AUF EINER 16px-SCHEIBE (Initialen-Schwelle-Regel).
  //
  // Hier standen bis zuletzt zwei Buchstaben auf einer 16-%-Waschung - unter der
  // 20px-Schwelle, ab der die Regel Text überhaupt erlaubt, und direkt neben dem
  // ausgeschriebenen Namen, den sie abkürzten. Die Scheibe trägt ihre Identität
  // jetzt so, wie die Regel es vorsieht: als Farbe allein, im Vollton. Der Name
  // steht unverändert daneben, es geht also nichts verloren.
  //
  // Die Zettelfarbe darüber bleibt beim gemessenen 16-%-Rezept - sie ist eine
  // ganze Inhaltsfläche, und für die gilt die User-Farben-Regel weiter.
  const avatarColor = note.creator_color || AVATAR_FALLBACK_COLOR;

  return `
    <div class="note-card ${note.pinned ? 'note-card--pinned' : ''} ${!boardIsFiltered() && canArrangeItem(note,item,'move') ? 'note-card--editable' : ''}"
         data-id="${note.id}"
         style="--note-color:${esc(note.color)};">
      ${renderBoardMenu(note,item)}
      ${renderPositionControls(note,item)}
      ${renderNoteTitle(note)}
      <div class="note-card__content">${renderMarkdownLight(note.content, CHECKLIST_OPTS(note))}</div>
      <div class="note-card__footer">
        <div class="note-card__creator">
          <span class="note-card__avatar"
                style="--avatar-color:${esc(avatarColor)};">
            ${note.creator_avatar
              ? `<img src="${esc(note.creator_avatar)}" alt="${esc(memberLabel({ id: note.created_by, display_name: note.creator_name }))}" loading="lazy">`
              : ''}
          </span>
          <span>${esc(memberLabel({ id: note.created_by, display_name: note.creator_name }))}</span>
        </div>
      </div>
    </div>
  `;
}

// --------------------------------------------------------
// Modal
// --------------------------------------------------------

// Gerenderte Markdown-Leseansicht (Reader-Modus, Discussion #507). Nutzt den
// gemeinsamen renderMarkdownLight-Renderer. Der Notiztitel trägt der Modal-Header
// (Recognition), daher hier nur der Inhalt.
/**
 * @param {string} content Der anzuzeigende Text
 * @param {{ live?: boolean }} [opts] Sind die Kaestchen bedienbar? Nur wahr,
 *   wenn der gezeigte Text dem gespeicherten entspricht - der Lesemodus
 *   spiegelt sonst ungespeicherte Aenderungen, und dann zeigen seine
 *   Zeilennummern auf einen Text, den der Server noch nicht kennt (#704).
 */
function renderNoteReadHtml(content, { live = false } = {}) {
  const body = (content || '').trim()
    ? renderMarkdownLight(content, live ? CHECKLIST_OPTS() : {})
    : `<p class="note-read__empty">${t('notes.readEmpty')}</p>`;
  return `<div class="note-read__body">${body}</div>`;
}

function openNoteModal({ mode, note = null }) {
  if (mode === 'create' && !canNote('create')) return;
  if (note && !canOnNote(note, 'view')) return;
  if (note && !canOnNote(note, 'edit')) {
    openSharedModal({title: note.title || t('notes.viewNote'), size: 'lg',
      content: `<div class="note-modal" data-view="read" data-note-id="${note.id}"><div class="note-read-view">${renderNoteReadHtml(note.content)}</div>${canOnNote(note, 'delete') ? `<div class="modal-panel__footer"><button class="btn btn--danger-outline" id="note-modal-delete">${t('common.delete')}</button></div>` : ''}</div>`,
      onSave(panel) { panel.querySelector('#note-modal-delete')?.addEventListener('click', () => deleteNote(note.id)); }});
    return;
  }
  const isEdit      = mode === 'edit';
  const page = state, auth = authenticationSnapshot();
  const canManageAudience = getPermissions().principal_kind !== 'device' && (!isEdit || note.permissions?.manage_visibility === true);
  let originalRevision = note?.revision ?? 0;
  const selColor    = (isEdit ? note.color : null) || NOTE_COLORS[0];
  // Bestehende Notizen können Farben außerhalb der Palette tragen (Alt-Daten,
  // frühere Paletten). Die aktuelle Farbe wird dann als eigener Swatch
  // vorangestellt: sonst wäre nichts selektiert und die Radio-Gruppe hätte
  // keinen Tastatur-Einstieg (kein tabindex="0" im Roving-Muster).
  const swatchColors = NOTE_COLORS.includes(selColor) ? NOTE_COLORS : [selColor, ...NOTE_COLORS];
  // Bestehende Notizen öffnen im Lese-Modus (#507); neue direkt im Editor.
  const initialView = isEdit ? 'read' : 'edit';

  const content = `
    <div class="note-modal" data-view="${initialView}"${isEdit ? ` data-note-id="${note.id}"` : ''} style="--note-color:${esc(selColor)};">
      <div class="note-mode-switch" role="tablist" aria-label="${t('notes.modeSwitchLabel')}">
        <button type="button" id="note-tab-read" class="sub-tab${initialView === 'read' ? ' sub-tab--active' : ''}"
                role="tab" aria-selected="${initialView === 'read' ? 'true' : 'false'}"
                aria-controls="note-pane-read" tabindex="${initialView === 'read' ? '0' : '-1'}" data-view="read">
          <i data-lucide="book-open" class="sub-tab__icon" aria-hidden="true"></i>
          <span class="sub-tab__label">${t('notes.modeRead')}</span>
        </button>
        <button type="button" id="note-tab-edit" class="sub-tab${initialView === 'edit' ? ' sub-tab--active' : ''}"
                role="tab" aria-selected="${initialView === 'edit' ? 'true' : 'false'}"
                aria-controls="note-pane-edit" tabindex="${initialView === 'edit' ? '0' : '-1'}" data-view="edit">
          <i data-lucide="pencil" class="sub-tab__icon" aria-hidden="true"></i>
          <span class="sub-tab__label">${t('notes.modeEdit')}</span>
        </button>
      </div>

      <div class="note-read-view" id="note-pane-read" data-pane="read" role="tabpanel"
           aria-labelledby="note-tab-read" tabindex="-1"${initialView === 'read' ? '' : ' hidden'}>
        ${isEdit ? renderNoteReadHtml(note.content, { live: true }) : ''}
      </div>

      <div class="note-edit-view" id="note-pane-edit" data-pane="edit" role="tabpanel"
           aria-labelledby="note-tab-edit"${initialView === 'edit' ? '' : ' hidden'}>
    ${canManageAudience ? `<div class="form-group">
      <label class="form-label" for="note-visibility">${t('notes.visibleTo')}</label>
      <select class="form-input" id="note-visibility">${['private', 'all', 'selected'].map(value => `<option value="${value}"${(note?.visibility || 'all') === value ? ' selected' : ''}>${t(`notes.audience.${value}`)}</option>`).join('')}</select>
      <p class="form-hint">${t('notes.audienceHint')}</p>
      <fieldset id="note-members"${note?.visibility === 'selected' ? '' : ' hidden'}><legend>${t('notes.chooseMembers')}</legend><div id="note-member-options" role="status">${t('common.loading')}</div></fieldset>
    </div>` : `<p class="note-audience-summary">${t('notes.visibleTo')}: ${t(`notes.audience.${note?.visibility || 'all'}`)}</p>`}
    <div class="form-group">
      <label class="form-label" for="note-title">${t('notes.titleLabel')}</label>
      <input type="text" class="form-input" id="note-title"
             placeholder="${t('notes.titlePlaceholder')}" value="${esc(isEdit && note.title ? note.title : '')}">
    </div>
    <div class="form-group">
      <label class="form-label" for="note-content">${t('notes.contentLabel')} <span class="form-label__hint">${t('notes.contentMarkdownHint')}</span></label>
      ${renderMarkdownToolbar()}
      <textarea class="form-input" id="note-content" rows="6"
                placeholder="${t('notes.contentPlaceholder')}"
                style="resize:vertical;">${esc(isEdit ? note.content : '')}</textarea>
    </div>
    ${advancedSection(`
      <div class="form-group">
        <label class="form-label" id="note-color-label">${t('notes.colorLabel')}</label>
        <div class="note-color-picker" role="radiogroup" aria-labelledby="note-color-label">
          ${swatchColors.map((c) => `
            <div class="note-color-swatch ${c === selColor ? 'note-color-swatch--active' : ''}"
                 data-color="${esc(c)}"
                 style="background-color:${esc(c)};border:2px solid ${c === NOTE_COLORS[7] ? 'var(--color-border)' : esc(c)};"
                 role="radio"
                 tabindex="${c === selColor ? '0' : '-1'}"
                 aria-checked="${c === selColor ? 'true' : 'false'}"
                 aria-label="${esc(NOTE_COLOR_NAMES()[c] ?? t('notes.colorCurrent'))}"></div>
          `).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="toggle">
          <input type="checkbox" id="note-pinned" ${isEdit && note.pinned ? 'checked' : ''}>
          <span class="toggle__track"></span>
          <span>${t('notes.pinnedLabel')}</span>
        </label>
      </div>`,
      { open: isEdit && (!!note.pinned || (!!note.color && note.color !== NOTE_COLORS[0])) })}
      </div>

      <div class="modal-panel__footer modal-panel__footer--plain note-modal__footer">
        ${isEdit && canOnNote(note, 'delete') ? `<button type="button" class="btn btn--danger-outline" id="note-modal-delete" style="margin-right:auto">${t('common.delete')}</button>` : ''}
        <button type="button" class="btn btn--secondary" id="note-modal-cancel" data-editor-only>${t('common.cancel')}</button>
        <button type="button" class="btn btn--primary" id="note-modal-save" data-editor-only>${isEdit ? t('common.save') : t('common.create')}</button>
      </div>
    </div>`;

  openSharedModal({
    title: isEdit && note.title && note.title.trim() ? note.title : (isEdit ? t('notes.viewNote') : t('notes.newNote')),
    content,
    // 'lg' statt 'md' (#826): eine Notiz ist fast nur Textflaeche und bekam
    // dieselbe Breite wie ein Formular aus vier kurzen Feldern. Das ist der
    // Dialog, der einheitlich ist, wo er es nicht sein sollte. 'lg' (680px) ist
    // dabei die Groesse, die das Haus fuer inhaltsreiche Dialoge schon fuehrt
    // (Dokumente, Kontakte, Einkauf, Budget) - keine neue Zahl. 'xl' waere zu
    // weit: bei 960px wird die Zeile zum Lesen wie zum Schreiben zu lang, und
    // die Leseansicht derselben Notiz haengt an derselben Breite.
    size: 'lg',
    onSave(panel) {
      const visibility = panel.querySelector('#note-visibility');
      visibility?.addEventListener('change', () => {
        panel.querySelector('#note-members').hidden = visibility.value !== 'selected';
      });
      if (visibility) {
        api.get('/notes/members').then(res => {
          if (!currentPage(page, auth) || !panel.isConnected) return;
          const options = panel.querySelector('#note-member-options');
          options.replaceChildren();
          options.insertAdjacentHTML('beforeend', res.data.filter(member => member.id !== state.user?.id).map(member => `<label class="note-member-option"><input type="checkbox" data-note-member="${member.id}" value="${member.id}"${note?.access_user_ids?.includes(member.id) ? ' checked' : ''}><span>${esc(memberLabel(member))}</span></label>`).join(''));
        }).catch(() => {
          if (!currentPage(page, auth) || !panel.isConnected) return;
          panel.querySelector('#note-member-options').textContent = t('notes.membersUnavailable');
        });
      }
      // Reader/Editor-Umschalter (#507): beide Panes bleiben im DOM, damit
      // Dirty-Check und Feld-Verdrahtung intakt bleiben und der Toggle nichts
      // verwirft. Die Leseansicht wird bei jedem Wechsel aus den Live-Feldern
      // neu gerendert, spiegelt also ungespeicherte Änderungen.
      const noteModal   = panel.querySelector('.note-modal');
      const readPane    = panel.querySelector('[data-pane="read"]');
      const editPane    = panel.querySelector('[data-pane="edit"]');
      const editorOnly  = [...panel.querySelectorAll('[data-editor-only]')];
      const titleEl     = document.getElementById('shared-modal-title');
      const modeTabs    = [...panel.querySelectorAll('.note-mode-switch .sub-tab')];
      const viewTitle   = panel.querySelector('#note-title');
      const viewContent = panel.querySelector('#note-content');
      const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
      let draftStarted = !isEdit;

      function animatePane(pane) {
        if (reduceMotion) return;
        pane.classList.remove('note-pane--enter');
        void pane.offsetWidth; // Reflow: Animation bei jedem Wechsel neu starten
        pane.classList.add('note-pane--enter');
      }

      // Header spiegelt den Titel live (deckt auch Create ab, wo der Header sonst
      // bis zur ersten Vorschau „Neue Notiz" bliebe). Fallback je nach Modus.
      function syncHeaderTitle() {
        if (!titleEl) return;
        titleEl.textContent = viewTitle.value.trim() || (isEdit ? t('notes.viewNote') : t('notes.newNote'));
      }

      function setView(view, { focusField = false } = {}) {
        if (view === 'edit' && !draftStarted) {
          // The first editor draft starts from the complete current snapshot,
          // including successful reader checklist operations. Later read/edit
          // switches must never rebase an existing draft over another writer.
          const fresh = state.notes.find(n => n.id === note.id);
          if (fresh) {
            originalRevision = fresh.revision ?? originalRevision;
            note = fresh;
            viewTitle.value = fresh.title || '';
            viewContent.value = fresh.content || '';
            panel.querySelector('#note-pinned').checked = !!fresh.pinned;
            const swatch = [...panel.querySelectorAll('.note-color-swatch')].find(el => el.dataset.color === fresh.color);
            if (swatch) selectSwatch(swatch);
            if (visibility) {
              visibility.value = fresh.visibility || 'all';
              panel.querySelector('#note-members').hidden = visibility.value !== 'selected';
              panel.querySelectorAll('[data-note-member]').forEach(input => { input.checked = fresh.access_user_ids?.includes(Number(input.value)) || false; });
            }
          }
          draftStarted = true;
        }
        noteModal.dataset.view = view;
        readPane.hidden = view !== 'read';
        editPane.hidden = view !== 'edit';
        // Abbrechen/Speichern sind nur im Editor sinnvoll. Löschen bleibt in
        // beiden Modi stehen: zuvor verschwand die Fußzeile im Lese-Modus
        // komplett, wodurch die geöffnete Notiz keine einzige Objektaktion mehr
        // anbot — anders als das Aufgaben-Modal, das Löschen inline führt.
        editorOnly.forEach((el) => { el.style.display = view === 'read' ? 'none' : ''; });
        modeTabs.forEach((b) => {
          const on = b.dataset.view === view;
          b.classList.toggle('sub-tab--active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
          b.tabIndex = on ? 0 : -1;
        });
        if (view === 'read') {
          // Live-Spiegelung: Farbe aus dem aktiven Swatch, Inhalt frisch gerendert
          // — Lesemodus zeigt ungespeicherte Änderungen.
          const c = panel.querySelector('.note-color-swatch--active')?.dataset.color;
          if (c) noteModal.style.setProperty('--note-color', c);
          syncHeaderTitle();
          readPane.replaceChildren();
          // Bedienbar nur, solange der Lesemodus den gespeicherten Stand zeigt:
          // sobald im Editor etwas Ungespeichertes steht, zaehlen dessen Zeilen
          // anders als die der Notiz auf dem Server (#704).
          readPane.insertAdjacentHTML('beforeend', renderNoteReadHtml(viewContent.value, {
            live: isEdit && viewContent.value === note.content,
          }));
          animatePane(readPane);
        } else {
          animatePane(editPane);
          // Cursor nur bei bewusster Maus-Aktivierung ins Textfeld setzen; bei
          // Pfeiltasten-Navigation bleibt der Fokus auf der Tab-Pille (roving),
          // sonst würde der Textarea-Fokus das Tablist-Verhalten brechen.
          if (focusField) setTimeout(() => viewContent.focus(), 30);
        }
      }
      // Haken im Lesemodus (#704). Der Handler haengt am Pane und nicht an den
      // Kaestchen: die werden bei jedem Moduswechsel neu gezeichnet, der Pane
      // bleibt. Nach dem Umschalten traegt der Textarea den neuen Stand mit,
      // sonst zeigte ein Wechsel in den Editor den Haken nicht mehr.
      readPane.addEventListener('click', async (e) => {
        const box = e.target.closest('.note-md-box[data-md-line]');
        if (!box || !isEdit) return;
        await toggleCheck(note.id, box);
        const fresh = state.notes.find((n) => n.id === note.id);
        if (fresh) {
          note.content = fresh.content;
          if (viewContent.value !== fresh.content) viewContent.value = fresh.content;
        }
      });

      // Initialen Footer-Zustand an die Startansicht angleichen.
      editorOnly.forEach((el) => { el.style.display = initialView === 'read' ? 'none' : ''; });
      viewTitle.addEventListener('input', syncHeaderTitle);

      panel.querySelector('#note-modal-delete')?.addEventListener('click', () => {
        deleteNote(note.id);
      });

      // Umschalt-Buttons + WAI-ARIA-Tablist-Tastatur (Pfeile/Home/End), konsistent
      // mit der geteilten .sub-tab-Grammatik (Budget-Scope, Kitchen-Tabs).
      modeTabs.forEach((tab, i) => {
        // Maus-Klick auf „Bearbeiten“ setzt den Cursor ins Textfeld (Produktivität);
        // „Lesen“ nicht. Pfeiltasten (unten) halten den Fokus auf der Pille.
        tab.addEventListener('click', () => setView(tab.dataset.view, { focusField: tab.dataset.view === 'edit' }));
        tab.addEventListener('keydown', (e) => {
          let ni = null;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') ni = (i + 1) % modeTabs.length;
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ni = (i - 1 + modeTabs.length) % modeTabs.length;
          else if (e.key === 'Home') ni = 0;
          else if (e.key === 'End') ni = modeTabs.length - 1;
          if (ni === null) return;
          e.preventDefault();
          setView(modeTabs[ni].dataset.view);
          modeTabs[ni].focus();
        });
      });

      // Fokus beim Öffnen im Lese-Modus auf die aktive Umschalt-Pille (statt auf
      // den Schließen-Button, wo openModal sonst landet). Ein Bedienelement ist
      // der bessere erste Stopp als der große Lese-Container — kleiner Fokusring,
      // sauberer SR-Einstieg in den Lese/Bearbeiten-Umschalter.
      if (initialView === 'read') {
        setTimeout(() => panel.querySelector('.note-mode-switch .sub-tab--active')?.focus(), 80);
      }

      // Farb-Swatch: Auswahl + ARIA + Keyboard (Roving Tabindex)
      function selectSwatch(target) {
        panel.querySelectorAll('.note-color-swatch').forEach((s) => {
          s.classList.remove('note-color-swatch--active');
          s.setAttribute('aria-checked', 'false');
          s.setAttribute('tabindex', '-1');
        });
        target.classList.add('note-color-swatch--active');
        target.setAttribute('aria-checked', 'true');
        target.setAttribute('tabindex', '0');
      }
      panel.querySelectorAll('.note-color-swatch').forEach((sw) => {
        sw.addEventListener('click', () => { selectSwatch(sw); sw.focus(); });
        sw.addEventListener('keydown', (e) => {
          const swatches = [...panel.querySelectorAll('.note-color-swatch')];
          const idx = swatches.indexOf(sw);
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = swatches[(idx + 1) % swatches.length];
            selectSwatch(next); next.focus();
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = swatches[(idx - 1 + swatches.length) % swatches.length];
            selectSwatch(prev); prev.focus();
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectSwatch(sw);
          }
        });
      });

      // Formatierungs-Toolbar (geteilt mit den Aufgaben-Notizen, #731)
      const textarea = panel.querySelector('#note-content');
      wireMarkdownToolbar(panel, textarea);

      panel.querySelector('#note-modal-cancel').addEventListener('click', closeModal);

      panel.querySelector('#note-modal-save').addEventListener('click', async () => {
        if (!currentPage(page, auth) || !canNote(isEdit ? 'edit' : 'create')) return;
        const saveBtn = panel.querySelector('#note-modal-save');
        const title   = panel.querySelector('#note-title').value.trim() || null;
        const cnt     = panel.querySelector('#note-content').value.trim();
        const color   = panel.querySelector('.note-color-swatch--active')?.dataset.color || NOTE_COLORS[0];
        const pinned  = panel.querySelector('#note-pinned').checked ? 1 : 0;
        const audience = visibility ? { visibility: visibility.value, access_user_ids: visibility.value === 'selected' ? [...panel.querySelectorAll('[data-note-member]:checked')].map(input => Number(input.value)) : [] }
          : !isEdit ? { visibility: 'all' } : {};
        if (audience.visibility === 'selected' && !audience.access_user_ids.length) {
          reportFieldError(visibility, t('notes.memberRequired')); return;
        }

        if (!cnt) {
          // Fehler am Feld statt als ortloser Toast (geteiltes Muster, Critique P1).
          reportFieldError(panel.querySelector('#note-content'), t('common.contentRequired'));
          return;
        }

        saveBtn.disabled    = true;
        saveBtn.textContent = '…';

        try {
          if (mode === 'create') {
            const res = await api.post('/notes', { title, content: cnt, color, pinned, ...audience });
            if (!currentPage(page, auth) || !panel.isConnected) return;
            if (canNote('view') && res.data) state.notes.unshift(res.data);
          } else {
            const res = await api.put(`/notes/${note.id}`, { title, content: cnt, color, pinned, expected_revision: originalRevision, ...audience });
            if (!currentPage(page, auth) || !panel.isConnected) return;
            const idx = state.notes.findIndex((n) => n.id === note.id);
            if (idx !== -1) state.notes[idx] = res.data;
            state.notes.sort((a, b) => b.pinned - a.pinned);
          }
          closeModal({ force: true });
          renderGrid();
          window.yuvomi?.showToast(mode === 'create' ? t('notes.createdToast') : t('notes.savedToast'), 'success');
        } catch (err) {
          if (!currentPage(page, auth) || !panel.isConnected) return;
          if (err.status === 403 || err.status === 404) { await reloadNotes(); if (!panel.isConnected) return; }
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
          btnError(saveBtn);
          saveBtn.disabled    = false;
          saveBtn.textContent = isEdit ? t('common.save') : t('common.create');
        }
      });
    },
  });
}

// --------------------------------------------------------
// Aktionen
// --------------------------------------------------------

async function togglePin(id) {
  const note = state.notes.find(n => n.id === id);
  if (!note || !canOnNote(note, 'edit')) return;
  const page = state, auth = authenticationSnapshot();
  try {
    const res  = await api.patch(`/notes/${id}/pin`, { expected_revision: note.revision ?? 0 });
    if (!currentPage(page, auth)) return;
    note.pinned = res.data.pinned;
    note.revision = res.data.revision ?? note.revision;
    state.notes.sort((a, b) => b.pinned - a.pinned);
    renderGrid();
  } catch (err) {
    if (!currentPage(page, auth)) return;
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    await reloadNotes();
  }
}

/**
 * Notizen frisch vom Server holen (#704).
 *
 * Der Weg nach einem Konflikt: der eigene Stand ist nachweislich veraltet,
 * also wird er ersetzt statt geflickt. Die Sortierung kommt vom Server mit,
 * damit sie nicht ein zweites Mal hier steht.
 */
async function reloadNotes() {
  if (!state.active) return;
  const page = state, auth = page.auth;
  if (!canNote('view')) { page.readSequence=(page.readSequence||0)+1; acceptBoardView({notes:[],groups:[]}); closeModal({ force: true }); renderGrid(); groupStatus(''); return; }
  const sequence = page.readSequence = (page.readSequence || 0) + 1;
  try {
    const res = await api.get('/notes/board',{signal:page.requests.signal,requireFresh:true});
    if (!currentPage(page, auth) || page.readSequence !== sequence) return;
    const modal = document.querySelector('.note-modal[data-note-id]');
    if (modal) {
      const fresh = res.data.notes.find(n => n.id === Number(modal.dataset.noteId));
      if (!fresh || (modal.querySelector('#note-content') && !canOnNote(fresh, 'edit')) || (modal.hasAttribute('data-layout-editor') && !canArrangeNote(fresh)) || (modal.querySelector('#note-visibility') && fresh.permissions?.manage_visibility !== true)) closeModal({ force: true });
    }
    const {fresh,changed,lostAccess}=acceptBoardView(res.data);
    const recovered=!!page.layoutRecovery;
    page.layoutRecovery=false;
    renderCreatorFilter();
    if (recovered || !board?.busy() || changed) renderGrid();
    if (lostAccess || recovered || (changed && !page.groupRetry && !page.groupPending)) groupStatus('');
    return fresh;
  } catch (err) {
    if (!currentPage(page, auth) || page.readSequence !== sequence) return;
    // Fail closed when current authorization cannot be established.
    if ([401,403,404,409].includes(err.status)) {
      acceptBoardView({notes:[],groups:[]}); closeModal({ force: true }); renderCreatorFilter(); renderGrid(); groupStatus('');
    }
    console.error('[Notes] Neuladen fehlgeschlagen:', err);
  }
}

async function deleteNote(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note || !canOnNote(note, 'delete')) return;
  const auth = authenticationSnapshot(), originalState = state;
  originalState.deleting.add(id);
  closeModal({ force: true });
  state.notes = state.notes.filter((n) => n.id !== id);
  renderGrid();
  vibrate([30, 50, 30]);

  scheduleUndoableDelete({
    message: t('notes.deletedToast'),
    commit: async ({ keepalive }) => {
      if (!sameAuthentication(auth) || !canNote('delete')) return;
      await api.delete(`/notes/${id}?expected_revision=${note.revision ?? 0}`, { keepalive });
      originalState.deleting.delete(id);
    },
    restore: (err) => {
      originalState.deleting.delete(id);
      if (!currentPage(originalState, auth)) return;
      // Undo must reauthorize: never repaint a cached restricted note.
      reloadNotes();
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}

function layoutStatus(text) {
  const status = _container?.querySelector('#notes-board-status');
  if (status) { status.textContent = text; status.title = text; }
}

// The command owner admits one board write at a time. Do not let a gesture
// paint an optimistic position when that owner cannot accept its drop.
function layoutWriteState(page=state) {
  return page.groupPending ? 'saving' : page.layoutRecovery==='loading' ? 'recovering'
    : page.groupRetry || page.layoutRecovery==='failed' ? 'retry' : '';
}
function layoutWriteMessage(page=state) {
  return t(layoutWriteState(page)==='saving' ? 'notes.layoutSaving'
    : layoutWriteState(page)==='recovering' ? 'common.loading' : 'notes.layoutFailed');
}
function canBeginLayout(page=state) {
  if (!page.active || state!==page) return false;
  const phase=layoutWriteState(page);
  if (!phase) return true;
  // Keep the uncertain-outcome explanation and its explicit Retry/Reload.
  if (phase!=='retry') layoutStatus(layoutWriteMessage(page));
  return false;
}
function syncLayoutWriteState() {
  const grid=_container?.querySelector('#notes-grid'), phase=layoutWriteState();
  if (grid) {
    if (phase) grid.dataset.layoutWrite=phase; else delete grid.dataset.layoutWrite;
    if (phase==='saving' || phase==='recovering') grid.setAttribute('aria-busy','true'); else grid.removeAttribute('aria-busy');
  }
  const organize=_container?.querySelector('#notes-organize');
  if (organize) organize.disabled=!!phase;
  state.groupInteractions?.setWriteState({ ...state.groupFeedback, phase });
}
async function reloadLayout(page=state) {
  if (!currentPage(page,page.auth)) return;
  page.layoutRecovery='loading'; groupStatus(t('common.loading'));
  const fresh=await reloadNotes();
  if (!currentPage(page,page.auth)) return;
  if (!fresh && page.layoutRecovery) {
    page.layoutRecovery='failed'; groupStatus(t('notes.layoutFailed'),{reload:true});
  }
  // A newer successful refresh may have superseded this read. It already
  // established current authority/revisions and cleared the recovery gate.
  return fresh || (!page.layoutRecovery ? {notes:page.notes,groups:page.groups} : undefined);
}

function groupStatus(message, { retry=null, undo=null, reload=false } = {}) {
  layoutStatus(message);
  syncLayoutWriteState();
  _container?.querySelector('#notes-group-actions')?.remove();
  const status = _container?.querySelector('#notes-board-status');
  const feedback = { message, phase: layoutWriteState(), actions: [] };
  state.groupFeedback = feedback;
  state.groupInteractions?.setWriteState(feedback);
  if (!status || (!retry && !undo && !reload)) return;
  const page=state, auth=page.auth, actions=document.createElement('span'); actions.id='notes-group-actions';
  const button=(label,attribute,run)=>{
    feedback.actions.push({ label: t(label), attribute, run: () => currentPage(page,auth) && run() });
    const element=document.createElement('button'); element.type='button'; element.className='btn btn--ghost btn--sm';
    element.textContent=t(label); element.setAttribute(attribute,'');
    element.addEventListener('click',()=>{if(currentPage(page,auth)) Promise.resolve(run()).catch(()=>{});}); actions.append(element);
  };
  if (retry || reload) {
    if (retry) button('common.retry','data-group-retry',()=>submitGroupCommand(retry));
    button('common.reload','data-group-reload',async()=>{page.layoutRecovery='loading';page.groupRetry=null;cancelGroupDrafts(page);await reloadLayout(page);});
  } else if (undo) button('common.undo','data-group-undo',()=>{
    if (boardIsFiltered()) return;
    const draft=createNoteGroupDraft({notes:page.notes,groups:page.groups},newNoteGroupOperationId());
    return submitGroupCommand(freezeNoteGroupCommand(draft,'undo',{undo_operation_id:undo}));
  });
  status.after(actions);
  state.groupInteractions?.setWriteState(feedback);
}

/** The only group request owner. Frozen bodies are never rebuilt for Retry. */
async function submitGroupCommand(command) {
  const page=state, auth=page.auth, generation=page.boardGeneration, access=page.accessGeneration;
  if (!NOTE_GROUPS_INTERFACE_ENABLED || !currentPage(page,auth) || boardIsFiltered()) throw new Error(t('notes.layoutConflict'));
  if (page.groupPending || page.layoutRecovery || (page.groupRetry && page.groupRetry!==command)) throw new Error(layoutWriteMessage(page));
  page.groupPending=command; page.readSequence=(page.readSequence||0)+1; page.groupUndo=null;
  const pending=[...command.expected.notes.map(note=>note.id),...command.expected.groups.map(group=>`group:${group.id}`)];
  pending.forEach(id=>page.pending.add(id)); groupStatus(t('notes.layoutSaving'));
  try {
    const response=await api.post('/notes/group-operations',command,{signal:page.requests.signal});
    if (!currentPage(page,auth)) throw new DOMException('The Notes context ended.','AbortError');
    let result=response.data;
    if (result?.operation_id!==command.operation_id || !Array.isArray(result?.board?.notes) || !Array.isArray(result?.board?.groups)) throw Object.assign(new Error('The result is not yet known. Retry or reload the board.'),{outcome:'unknown'});
    page.readSequence++;
    // A newer access/revision refresh takes precedence over a delayed mutation body.
    if (page.boardGeneration!==generation || page.accessGeneration!==access) {
      const fresh=await reloadNotes();
      if (!currentPage(page,auth) || !fresh) throw Object.assign(new Error(t('notes.layoutConflict')),{status:409});
      result={...result,board:fresh,undo_available:false};
    } else acceptBoardView(result.board);
    if (!currentPage(page,auth)) throw new DOMException('The Notes context ended.','AbortError');
    page.groupPending=null; page.groupRetry=null; pending.forEach(id=>page.pending.delete(id));
    cancelGroupDrafts(page); page.groupUndo=result.undo_available?result.operation_id:null;
    renderCreatorFilter(); renderGrid(); groupStatus(t('notes.layoutSaved'),{undo:page.groupUndo});
    return result;
  } catch (error) {
    if (currentPage(page,auth)) {
      page.groupPending=null; pending.forEach(id=>page.pending.delete(id)); cancelGroupDrafts(page);
      const unknown=error.outcome==='unknown' || error.status===0;
      if (unknown && page.accessGeneration===access) {
        page.groupRetry=command; renderGrid(); groupStatus(error.message||t('notes.layoutFailed'),{retry:command});
      } else {
        page.groupRetry=null;
        const fresh=await reloadLayout(page);
        if (currentPage(page,auth)) {
          // An unchanged reload can skip painting while this placement is still
          // pending. Rebind the invalidated command context for the next drag.
          if (fresh) renderGrid();
          groupStatus(error.status===409?t('notes.layoutConflict'):error.data?.error||error.message||t('notes.layoutFailed'),{reload:!fresh});
        }
      }
    }
    error.groupCommandHandled=true; throw error;
  } finally {
    if (page.groupPending===command) page.groupPending=null;
    pending.forEach(id=>page.pending.delete(id));
    if (currentPage(page,auth)) syncLayoutWriteState();
  }
}

async function saveLayout(note, value) {
  const { x, y, width, height } = normalizeNoteLayout(value);
  return saveLayoutChange(note, { layout: { x, y, width, height } });
}

async function saveLayoutChange(note, changes) {
  if (!state.active || state.organizing || boardIsFiltered() || !canArrangeItem(note,null,Object.hasOwn(changes,'position_locked')?'pin':'move') || state.pending.has(note.id)) return false;
  const page = state, auth = authenticationSnapshot();
  page.pending.add(note.id);
  layoutStatus(t('notes.layoutSaving'));
  try {
    const res = await api.patch(`/notes/${note.id}/layout`, { expected_layout_revision: note.layout?.revision ?? 0, ...changes });
    if (!currentPage(page, auth)) return false;
    const current = state.notes.find(n => n.id === note.id);
    if (current) current.layout = res.data.layout || res.data;
    layoutStatus(t('notes.layoutSaved'));
    return true;
  } catch (err) {
    if (!currentPage(page, auth)) return false;
    layoutStatus(err.status === 409 ? t('notes.layoutConflict') : t('notes.layoutFailed'));
    await reloadNotes();
    return false;
  } finally { page.pending.delete(note.id); }
}

function openLayoutModal(id, kind = 'note') {
  if (!canBeginLayout()) return;
  // Retain the render's revision snapshot through the dialog's lifetime.
  const saveBoardCommand=state.boardActions?.saveBoardCommand;
  const findItem=()=>projectNoteGroupItems({notes:state.notes,groups:state.groups || []},{activePages:state.activePages}).find(item=>item.kind===kind && item.id===id);
  let item=findItem(), note=item?.note;
  const editable=()=>item && canArrangeItem(note,item,'move') && (kind!=='group'||!!saveBoardCommand);
  if (!editable() || state.pending.has(kind==='group'?`group:${id}`:id)) return;
  const layout = normalizeNoteLayout(item.layout);
  const page = state, auth = authenticationSnapshot();
  const fields = [['x', 0, 10000], ['y', 0, 10000], ['width', 3, 12], ['height', 4, 100]];
  openSharedModal({
    title: t('notes.adjustCard'),
    content: `<div class="note-modal" ${kind==='group'?`data-group-id="${id}"`:`data-note-id="${id}"`} data-layout-editor>
      ${kind==='note'?`<p>${t('notes.layoutHint')}</p>`:''}
      <div class="note-layout-fields">${fields.map(([name, min, max]) => `<div class="form-group"><label class="form-label" for="note-layout-${name}">${t(`notes.layoutField.${name}`)}</label><input class="form-input" type="number" inputmode="${name==='x'||name==='y'?'decimal':'numeric'}" min="${min}" max="${max}" step="${name==='x'||name==='y'?'any':'1'}" value="${layout[name]}" id="note-layout-${name}"></div>`).join('')}</div>
      <p id="note-layout-preview" role="status"></p>
      <div class="modal-panel__footer"><button class="btn btn--secondary" id="note-layout-cancel">${t('common.cancel')}</button><button class="btn btn--primary" id="note-layout-save">${t('common.save')}</button></div>
    </div>`,
    onSave(panel) {
      if (item.layout?.position_locked) for (const name of ['x', 'y']) panel.querySelector(`#note-layout-${name}`).disabled = true;
      const read = () => Object.fromEntries(fields.map(([name]) => [name, Number(panel.querySelector(`#note-layout-${name}`).value)]));
      const preview = () => {
        const next = normalizeNoteLayout(read());
        panel.querySelector('#note-layout-preview').textContent = t('notes.layoutPreview', next);
      };
      panel.querySelectorAll('input').forEach(input => input.addEventListener('input', preview)); preview();
      panel.querySelector('#note-layout-cancel').addEventListener('click', () => closeModal());
      panel.querySelector('#note-layout-save').addEventListener('click', async () => {
        if (!currentPage(page, auth)) return;
        for (const input of panel.querySelectorAll('input')) if (!input.reportValidity()) return;
        const btn = panel.querySelector('#note-layout-save'); btn.disabled = true;
        const ok = saveBoardCommand
          ? await saveBoardCommand({kind:'arrange',items:[noteGroupArrangeItem(item,read())],include_locked:true})
          : await saveLayout(note, read());
        if (!currentPage(page, auth) || !panel.isConnected) return;
        if (ok) { closeModal({ force: true }); renderGrid(); }
        else closeModal({ force:true });
      });
    },
  });
}

async function organizeNotes() {
  if (!NOTE_GROUPS_INTERFACE_ENABLED || !state.active || boardIsFiltered() || !canBeginLayout() || state.pending.size || board?.busy()) return;
  const includeLocked = _container.querySelector('#notes-organize-locked')?.checked === true;
  try {
    const all=projectNoteGroupItems({notes:state.notes,groups:state.groups},{activePages:state.activePages});
    const items=organizeNoteGroupItems(all,{includeLocked,canEdit:item=>noteItemAllows(item,'move')});
    if (items.length) await state.boardActions.saveBoardCommand({kind:'arrange',items,include_locked:includeLocked});
  } catch (error) { layoutStatus(error.message||t('notes.layoutFailed')); }
}
