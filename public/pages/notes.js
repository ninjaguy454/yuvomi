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
import { getPermissions, moduleAccess, canCapability } from '/permissions.js';
import { authenticationSnapshot, sameAuthentication } from '/utils/device-context.js';
import { wireNoteBoard } from '/components/note-board.js';
import { normalizeNoteLayout, organizeNoteLayouts } from '/utils/note-board-layout.js';
import { watchNoteChanges } from '/utils/note-live.js';
import { mountOpenTaskBoard } from '/components/open-task-board.js';

const canNote = action => getPermissions().principal_kind === 'device'
  ? moduleAccess('notes') !== 'none' && canCapability(`device_notes.${action}`)
  : moduleAccess('notes') === 'write' || (action === 'view' && moduleAccess('notes') === 'read');
const canOnNote = (note, action) => canNote(action) && note?.permissions?.[action] !== false;

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

let state = { notes: [], user: null, filterQuery: '', filterCreator: '' };
let _container = null;
let board = null;
let stopLive = null;
let stopOpenTasks = null;
const currentPage = (page, auth) => state === page && page.active && sameAuthentication(auth);

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
 * Bewusst kein `renderGrid()`: das baute das ganze Raster neu, mit Einblend-
 * Staffelung und verlorenem Fokus - fuer einen Haken. Und da `state.notes` nicht
 * umsortiert wird, springt die Notiz auch nicht unter dem Finger weg; die neue
 * Reihenfolge greift beim naechsten vollen Laden.
 */
function paintCheck(noteId, line, checked) {
  const roots = [
    _container?.querySelector(`.note-card[data-id="${noteId}"] .note-card__content`),
    document.querySelector(`.note-modal[data-note-id="${noteId}"] .note-read__body`),
  ];
  for (const root of roots) {
    const box = root?.querySelector(`.note-md-box[data-md-line="${line}"]`);
    if (!box) continue;
    box.setAttribute('aria-checked', String(checked));
    box.dataset.mdChecked = checked ? '1' : '0';
    box.closest('.note-md-check')?.classList.toggle('is-checked', checked);
  }
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
    note.content = res.data.content;
    note.updated_at = res.data.updated_at;
    note.revision = res.data.revision ?? note.revision;
  } catch (err) {
    if (!currentPage(page, auth)) return;
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
  if (state) state.active = false;
  _container = container;
  state = { notes: [], user, filterQuery: '', filterCreator: '', compact: false, active: true, listDensity: 'expanded', expandedNotes: new Set(), pending: new Set(), deleting: new Set(), viewport: {} };
  const pageState = state;
  const auth = authenticationSnapshot();
  const clearNotes = () => { if (state === pageState) { state.active = false; state.notes = []; state.expandedNotes.clear(); board?.destroy(); board = null; stopLive?.(); stopLive = null; stopOpenTasks?.(); stopOpenTasks = null; container.replaceChildren(); closeModal({ force: true }); } };
  window.addEventListener('auth:context-ending', clearNotes, { once: true });
  window.addEventListener('auth:expired', clearNotes, { once: true });

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="notes-page">
      <div class="page-toolbar notes-toolbar">
        <h1 class="page-toolbar__title">${t('notes.title')}</h1>
        <div class="notes-header-actions" id="notes-header-actions">
          <button type="button" class="btn btn--ghost btn--icon" id="notes-compact-view" aria-label="${t('notes.compactView')}" title="${t('notes.compactView')}" aria-pressed="false"><i data-lucide="list" class="icon-md" aria-hidden="true"></i></button>
          ${canNote('view') && canNote('edit') ? `<button type="button" class="btn btn--ghost btn--icon" id="notes-organize" aria-label="${t('notes.organize')}" title="${t('notes.organize')}"><i data-lucide="layout-grid" class="icon-md" aria-hidden="true"></i></button><label id="notes-include-locked" class="btn btn--ghost btn--icon notes-include-locked" title="${t('notes.includeLocked')}"><input type="checkbox" id="notes-organize-locked" aria-label="${t('notes.includeLocked')}"><i data-lucide="pin" class="icon-md" aria-hidden="true"></i></label>` : ''}
        </div>
        ${renderPageSearch({ id: 'notes-search', label: t('notes.searchPlaceholder'), placeholder: t('notes.searchPlaceholder'), value: state.filterQuery, clearLabel: t('common.searchClear'), className: 'notes-toolbar__search' })}
        <button class="btn btn--primary toolbar-new-btn" id="notes-add-btn" aria-label="${t('notes.addNoteLabel')}">
          <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
          <span class="toolbar-new-btn__label">${t('newLabel.notes')}</span>
        </button>
      </div>
      <div class="notes-board-toolbar">
        <label class="notes-list-density" id="notes-list-density-label" hidden>${t('notes.listDensity')}
          <select id="notes-list-density"><option value="compact">${t('notes.listCompact')}</option><option value="expanded" selected>${t('notes.listExpanded')}</option></select>
        </label>
        <div class="notes-zoom-controls" id="notes-zoom-controls" hidden>
          <button type="button" class="btn btn--ghost btn--sm" id="notes-zoom-out" aria-label="${t('notes.zoomOut')}">−</button><output id="notes-zoom-value">100%</output>
          <button type="button" class="btn btn--ghost btn--sm" id="notes-zoom-in" aria-label="${t('notes.zoomIn')}">+</button><button type="button" class="btn btn--ghost btn--sm" id="notes-reset-view">${t('notes.resetView')}</button>
        </div>
        <span id="notes-board-status" class="notes-board-status" role="status" aria-live="polite"></span>
      </div>
      <div class="notes-filters" id="notes-filters" role="group" aria-label="${t('notes.filterCreatorLabel')}" hidden></div>
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
    const res  = canNote('view') ? await api.get('/notes') : { data: [] };
    if (!currentPage(pageState, auth)) return () => {};
    state.notes = res.data;
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
    if (adjust) { e.stopPropagation(); openLayoutModal(Number(adjust.closest('.note-card').dataset.id)); return; }
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
  return () => { window.removeEventListener('auth:context-ending', clearNotes); window.removeEventListener('auth:expired', clearNotes); clearNotes(); };
}

// --------------------------------------------------------
// Grid
// --------------------------------------------------------

/**
 * Ersteller-Filterzeile. Erst ab zwei Autorinnen/Autoren sinnvoll — in einem
 * Ein-Personen-Haushalt wäre sie ein Chip ohne Alternative. Nutzt dieselben
 * Button-Chips wie Dokumente/Aufgaben (Tastatur + aria-pressed).
 */
function renderCreatorFilter() {
  const row = _container.querySelector('#notes-filters');
  if (!row) return;

  const creators = [...new Map(
    state.notes
      .filter((n) => n.creator_name)
      .map((n) => [n.creator_name, n])
  ).values()];

  row.hidden = creators.length < 2;
  row.replaceChildren();
  if (row.hidden) return;

  const makeChip = (label, value) => {
    const active = state.filterCreator === value;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `filter-chip filter-chip--sm${active ? ' filter-chip--active' : ''}`;
    chip.dataset.creator = value;
    chip.setAttribute('aria-pressed', String(active));
    chip.textContent = label;
    return chip;
  };

  row.appendChild(makeChip(t('common.all'), ''));
  creators.forEach((n) => row.appendChild(makeChip(n.creator_name, n.creator_name)));

  row.querySelectorAll('[data-creator]').forEach((chip) => {
    chip.addEventListener('click', () => {
      // Erneuter Klick auf den aktiven Chip hebt den Filter auf.
      state.filterCreator = state.filterCreator === chip.dataset.creator ? '' : chip.dataset.creator;
      renderCreatorFilter();
      renderGrid();
    });
  });
}

function visibleNotes() {
  const q = state.filterQuery.trim().toLowerCase();
  return state.notes.filter((n) => {
    if (state.filterCreator && n.creator_name !== state.filterCreator) return false;
    if (!q) return true;
    return (n.title   || '').toLowerCase().includes(q)
        || (n.content || '').toLowerCase().includes(q);
  });
}

function renderGrid() {
  if (!state.active) return;
  const grid = _container.querySelector('#notes-grid');
  if (!grid) return;
  const focused = document.activeElement?.closest('.note-card');
  const focusId = focused?.dataset.id;
  const focusAction = document.activeElement?.dataset.action;
  const focusBoardAction = document.activeElement?.dataset.boardAction;
  const focusExpand = document.activeElement?.hasAttribute('data-note-expand');
  const focusChecklistLine = document.activeElement?.dataset.mdLine;
  const previewScroll = new Map([...grid.querySelectorAll('.note-card')].map(card => [card.dataset.id, card.querySelector('.note-card__content')?.scrollTop || 0]));
  board?.destroy(); board = null;
  grid.removeAttribute('aria-busy');

  const q = state.filterQuery.trim().toLowerCase();
  const visible = visibleNotes();
  const forceCompact = state.notes.some(note => note.layout?.overflow);
  const scrollport = _container.querySelector('.notes-scroll');
  const usableWidth = scrollport.clientWidth - parseFloat(getComputedStyle(scrollport).paddingLeft) - parseFloat(getComputedStyle(scrollport).paddingRight);
  state.listView = state.compact || forceCompact || usableWidth < 640;
  grid.dataset.boardView = state.listView ? 'list' : 'canvas';
  grid.dataset.listDensity = state.listDensity;
  _container.querySelector('#notes-list-density-label').hidden = !state.listView;
  _container.querySelector('#notes-list-density').value = state.listDensity;
  const organizeButton = _container.querySelector('#notes-organize');
  if (organizeButton) organizeButton.hidden = state.listView;
  const includeLocked = _container.querySelector('#notes-include-locked');
  if (includeLocked) includeLocked.hidden = state.listView;
  _container.querySelector('#notes-zoom-controls').hidden = state.listView;
  for (const id of state.expandedNotes) if (!state.notes.some(note => note.id === id && canOnNote(note, 'view'))) state.expandedNotes.delete(id);
  const compactButton = _container.querySelector('#notes-compact-view');
  if (compactButton) { compactButton.hidden = usableWidth < 640; compactButton.disabled = forceCompact; compactButton.setAttribute('aria-pressed', String(state.compact || forceCompact)); }
  _container.querySelector('#notes-header-actions').hidden = usableWidth < 640 || forceCompact;

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
          : t('notes.noResultsCreatorDescription', { name: state.filterCreator }),
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
    board = wireNoteBoard(grid, { getNotes: visibleNotes, canEdit: note => canOnNote(note, 'edit'), saveLayout, viewState: state.viewport,
      compact: state.compact || forceCompact, filtered: !!q || !!state.filterCreator, onViewChange: renderGrid });
    return;
  }

  // Angepinnte Notizen standen schon immer vorn, aber ohne sichtbare Grenze:
  // die Trennung war nur aus dem Ring an der Karte zu erschließen. Zwei
  // Abschnittsköpfe machen die bestehende Sortierung lesbar. Sie erscheinen
  // nur, wenn es tatsächlich beide Gruppen gibt.
  const html = visible.map(renderNoteCard).join('');

  grid.replaceChildren();
  grid.insertAdjacentHTML('beforeend', html);
  if (window.lucide) lucide.createIcons({ el: grid });
  board = wireNoteBoard(grid, { getNotes: visibleNotes, canEdit: note => canOnNote(note, 'edit'), saveLayout, viewState: state.viewport,
    compact: state.compact || forceCompact, filtered: !!q || !!state.filterCreator, onViewChange: renderGrid });
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

function renderBoardMenu(note) {
  if (!canOnNote(note, 'edit') && !canOnNote(note, 'delete')) return '';
  return `<details class="note-card__menu" data-board-menu>
    <summary aria-label="${t('notes.cardMenu')}"><i data-lucide="ellipsis" class="icon-sm" aria-hidden="true"></i></summary>
    <div class="note-card__menu-items">
      ${canOnNote(note, 'edit') ? `<button type="button" data-action="pin" data-id="${note.id}" aria-pressed="${!!note.pinned}"><span aria-hidden="true">${note.pinned ? '✓' : ''}</span><span>${t('notes.showOnDashboard')}</span></button>
      <button type="button" data-board-action="top" aria-pressed="${!!note.layout?.always_on_top}"><span aria-hidden="true">${note.layout?.always_on_top ? '✓' : ''}</span><span>${t('notes.alwaysOnTop')}</span></button>` : ''}
      ${canOnNote(note, 'delete') ? `<button type="button" data-action="delete" data-id="${note.id}"><span aria-hidden="true"></span><span>${t('notes.deleteLabel')}</span></button>` : ''}
    </div>
  </details>`;
}

function renderPositionControls(note) {
  if (!canOnNote(note, 'edit')) return '';
  return `<button type="button" class="note-card__lock" data-board-action="lock" aria-label="${t('notes.positionLock')}" aria-pressed="${!!note.layout?.position_locked}"><i data-lucide="pin" class="icon-sm" aria-hidden="true"></i></button>
    <button type="button" class="note-card__adjust" data-board-action="adjust">${t('notes.adjustCard')}</button>`;
}

function renderNoteTitle(note) {
  return `<button type="button" class="note-card__title" data-action="open" data-id="${note.id}">${esc(note.title?.trim() || t('notes.untitledNote'))}</button>`;
}

function renderListCard(note) {
  const compact = state.listDensity === 'compact';
  const expanded = state.expandedNotes.has(note.id);
  const preview = compact ? null : listPreview(note, expanded);
  return `<div class="note-card note-card--list ${note.pinned ? 'note-card--pinned' : ''}" data-id="${note.id}" style="--note-color:${esc(note.color)};">
    <div class="note-card__list-heading">
      ${renderPositionControls(note)}
      ${renderNoteTitle(note)}
      ${renderBoardMenu(note)}
    </div>
    ${compact ? '' : `<div class="note-card__preview"><div class="note-card__content" id="note-list-body-${note.id}">${preview.html}</div>
      ${preview.truncated ? `<button type="button" class="note-card__expand" data-note-expand aria-expanded="${expanded}" aria-controls="note-list-body-${note.id}">${t(expanded ? 'notes.showLess' : 'notes.showMore')}</button>` : ''}</div>
      <div class="note-card__list-meta">${esc(note.creator_name || '')}</div>`}
  </div>`;
}

function renderNoteCard(note) {
  if (state.listView) return renderListCard(note);
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
    <div class="note-card ${note.pinned ? 'note-card--pinned' : ''} ${canOnNote(note, 'edit') ? 'note-card--editable' : ''}"
         data-id="${note.id}"
         style="--note-color:${esc(note.color)};">
      ${renderBoardMenu(note)}
      ${renderPositionControls(note)}
      ${renderNoteTitle(note)}
      <div class="note-card__content">${renderMarkdownLight(note.content, CHECKLIST_OPTS(note))}</div>
      <div class="note-card__footer">
        <div class="note-card__creator">
          <span class="note-card__avatar"
                style="--avatar-color:${esc(avatarColor)};">
            ${note.creator_avatar
              ? `<img src="${esc(note.creator_avatar)}" alt="${esc(note.creator_name || '')}" loading="lazy">`
              : ''}
          </span>
          <span>${esc(note.creator_name || '')}</span>
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
          options.insertAdjacentHTML('beforeend', res.data.filter(member => member.id !== state.user?.id).map(member => `<label class="note-member-option"><input type="checkbox" data-note-member="${member.id}" value="${member.id}"${note?.access_user_ids?.includes(member.id) ? ' checked' : ''}><span>${esc(member.display_name)}</span></label>`).join(''));
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
  const page = state, auth = authenticationSnapshot();
  if (!canNote('view')) { state.notes = []; closeModal({ force: true }); renderGrid(); return; }
  const sequence = page.readSequence = (page.readSequence || 0) + 1;
  try {
    const res = await api.get('/notes');
    if (!currentPage(page, auth) || page.readSequence !== sequence) return;
    const modal = document.querySelector('.note-modal[data-note-id]');
    if (modal) {
      const fresh = res.data.find(n => n.id === Number(modal.dataset.noteId));
      if (!fresh || ((modal.querySelector('#note-content') || modal.hasAttribute('data-layout-editor')) && !canOnNote(fresh, 'edit')) || (modal.querySelector('#note-visibility') && fresh.permissions?.manage_visibility !== true)) closeModal({ force: true });
    }
    // A remotely hidden/deleted note must immediately cancel a pending gesture.
    const disappeared = state.notes.some(n => !res.data.some(fresh => fresh.id === n.id));
    const changedAccess = state.notes.some(n => res.data.find(fresh => fresh.id === n.id)?.permissions?.edit !== n.permissions?.edit);
    state.notes = res.data.filter(note => !page.deleting.has(note.id));
    renderCreatorFilter();
    if (!board?.busy() || disappeared || changedAccess) renderGrid();
  } catch (err) {
    if (!currentPage(page, auth)) return;
    // Fail closed when current authorization cannot be established.
    if (err.status === 401 || err.status === 403 || err.status === 404) {
      state.notes = []; closeModal({ force: true }); renderCreatorFilter(); renderGrid();
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
  if (status) status.textContent = text;
}

async function saveLayout(note, value) {
  const { x, y, width, height } = normalizeNoteLayout(value);
  return saveLayoutChange(note, { layout: { x, y, width, height } });
}

async function saveLayoutChange(note, changes) {
  if (!state.active || state.organizing || !canOnNote(note, 'edit') || state.pending.has(note.id)) return false;
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

function openLayoutModal(id) {
  let note = state.notes.find(n => n.id === id);
  if (!note || !canOnNote(note, 'edit') || state.pending.has(id)) return;
  const layout = normalizeNoteLayout(note.layout);
  const page = state, auth = authenticationSnapshot();
  const fields = [['x', 0, 10000], ['y', 0, 10000], ['width', 3, 12], ['height', 4, 100]];
  openSharedModal({
    title: t('notes.adjustCard'),
    content: `<div class="note-modal" data-note-id="${id}" data-layout-editor>
      <p>${t('notes.layoutHint')}</p>
      <div class="note-layout-fields">${fields.map(([name, min, max]) => `<div class="form-group"><label class="form-label" for="note-layout-${name}">${t(`notes.layoutField.${name}`)}</label><input class="form-input" type="number" inputmode="numeric" min="${min}" max="${max}" step="1" value="${layout[name]}" id="note-layout-${name}"></div>`).join('')}</div>
      <p id="note-layout-preview" role="status"></p>
      <div class="modal-panel__footer"><button class="btn btn--secondary" id="note-layout-cancel">${t('common.cancel')}</button><button class="btn btn--primary" id="note-layout-save">${t('common.save')}</button></div>
    </div>`,
    onSave(panel) {
      if (note.layout?.position_locked) for (const name of ['x', 'y']) panel.querySelector(`#note-layout-${name}`).disabled = true;
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
        const ok = await saveLayout(note, read());
        if (!currentPage(page, auth) || !panel.isConnected) return;
        if (ok) { closeModal({ force: true }); renderGrid(); }
        else {
          note = state.notes.find(n => n.id === id);
          if (!note || !canOnNote(note, 'edit')) { closeModal({ force: true }); return; }
          const fresh = normalizeNoteLayout(note.layout);
          fields.forEach(([name]) => { const input = panel.querySelector(`#note-layout-${name}`); input.value = fresh[name]; input.disabled = !!note.layout?.position_locked && ['x','y'].includes(name); });
          btn.disabled = false; panel.querySelector('#note-layout-preview').textContent = t('notes.layoutConflict');
        }
      });
    },
  });
}

async function organizeNotes() {
  if (!state.active || state.organizing || state.pending.size || board?.busy()) return;
  const includeLocked = _container.querySelector('#notes-organize-locked')?.checked === true;
  const items = organizeNoteLayouts(visibleNotes(), { includeLocked, canEdit: note => canOnNote(note, 'edit') });
  if (!items.length) return;
  const page = state, auth = authenticationSnapshot();
  page.organizing = true;
  const button = _container.querySelector('#notes-organize'); if (button) button.disabled = true;
  layoutStatus(t('notes.layoutSaving'));
  try {
    await api.patch('/notes/layout', { items, include_locked: includeLocked });
    if (!currentPage(page, auth)) return;
    await reloadNotes(); layoutStatus(t('notes.layoutSaved'));
  } catch (err) {
    if (!currentPage(page, auth)) return;
    layoutStatus(err.status === 409 ? t('notes.layoutConflict') : t('notes.layoutFailed')); await reloadNotes();
  } finally {
    page.organizing = false;
    if (currentPage(page, auth) && button) button.disabled = false;
  }
}
