/**
 * Modul: Essensplan (Meals)
 * Zweck: Wochenansicht mit Mahlzeit-CRUD, Zutaten-Verwaltung und Einkaufslisten-Integration
 * Abhängigkeiten: /api.js, /router.js (window.yuvomi)
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal as closeSharedModal, selectModal, confirmModal, confirmOverModal, advancedSection, wireBlurValidation, reportFieldError, refreshDirtySnapshot } from '/components/modal.js';
import { stagger, scheduleUndoableDelete, wireScrollFade } from '/utils/ux.js';
import { t, formatDate, formatDayMonth, formatDateInput, parseDateInput, isDateInputValid } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { DEFAULT_CATEGORY_NAME } from '/utils/shopping-categories.js';
import { renderKitchenTabsBar } from '/utils/kitchen-tabs.js';
import { resolveShoppingTarget, announceTransfer, mountMissingShoppingList } from '/utils/kitchen-transfer.js';
import { ingredientRowHTML } from '/utils/ingredient-row.js';
import { addLocalDays, startOfLocalWeekKey, todayKey } from '/utils/date.js';
import { normalizeRecipeMealTypes, recipeSupportsMealType, recipeAllowsMealType } from '/utils/recipe-meal-types.js';
import { mountEmptyState, mountLoadError, emptyStateEl, emptyStateHTML } from '/utils/empty-state.js';
import { mealPayloadFromRecipe } from '/utils/recipe-to-meal.js';
import { zonedWeekday } from '/utils/timezone.js';
import { isWallModeEnabled } from '/utils/wall-mode.js';
import {
  decisionForMember,
  finalizedMealParticipantIds,
  mealCourseLimits,
  mealDisplayTitle,
  mealDecisionPayload,
  mealEditorRolePayload,
  mealEditorRoleState,
  mealMenuOptionLimitState,
  normalizeMealStatusModel,
  normalizeMealWeekModel,
  occurrencesByDate,
  scaleMealIngredientQuantity,
  selectedMenuItems,
} from '/utils/meal-week-model.js';

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const MEAL_TYPES = () => [
  { key: 'breakfast', label: t('meals.typeBreakfast'), icon: 'sunrise' },
  { key: 'lunch',     label: t('meals.typeLunch'),     icon: 'sun'     },
  { key: 'dinner',    label: t('meals.typeDinner'),    icon: 'moon'    },
  { key: 'snack',     label: t('meals.typeSnack'),     icon: 'cookie'  },
];

const DAY_NAMES = () => [
  t('meals.dayMo'), t('meals.dayDi'), t('meals.dayMi'), t('meals.dayDo'),
  t('meals.dayFr'), t('meals.daySa'), t('meals.daySo'),
];

const EXCLUDED_MEAL_CATEGORY_NAMES = new Set(['Haushalt', 'Drogerie']);

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = {
  currentWeek:      null,   // YYYY-MM-DD (Montag)
  meals:            [],
  recipes:          [],
  lists:            [],     // Einkaufslisten für Transfer-Dropdown
  categories:       [],     // Einkaufskategorien für Zutaten
  planning:         { timing_defaults: [], slots: [], members: [], execution_settings: null },
  selectionRequests: [],
  /** `mode` is the primary household lens. `viewMode` remains the secondary
   * board/timeline layout so the established timeline is not lost. */
  mode:             'choices',
  viewMode:         'week',
  currentUserId:    null,
  selectedMemberId: null,
  selectedContextId: null,
  weekModel:        null,
  statusModel:      null,
  weekModelError:   null,
  statusModelError: null,
  expandedOccurrences: new Set(),
  expandedStatusOptions: new Set(),
  deepLinkOpenKey:  null,
  deepLinkFocus:    null,
  desktopOccurrenceDialogKey: null,
  mealPlans:        [],
  grocerySettings: null,
  isAdmin:          false,
  modal:            null,
  visibleMealTypes: ['breakfast', 'lunch', 'dinner', 'snack'],
  /** Gefangener Fehler des letzten Wochen-Ladevorgangs, sonst null.
   *  Ohne dieses Feld ist eine fehlgeschlagene Woche von einer leeren Woche
   *  nicht zu unterscheiden - und der Renderer zeigte den Leerzustand. */
  loadError:        null,
};

// Container-Referenz für Hilfsfunktionen (wird in render() gesetzt)
let _container = null;
let _dragRecipeId = null;

/** Keep an explicit readable fallback beside each localized redesign string.
 * A localization audit guarantees that every key is also present in all
 * supported locale files. */
function mealText(key, fallback, params = {}) {
  const translated = t(key, params);
  if (translated !== key) return translated;
  return String(fallback).replace(/\{\{(\w+)\}\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

// --------------------------------------------------------
// Datumshelfer
// --------------------------------------------------------

function getMondayOf(dateStr) {
  return startOfLocalWeekKey(dateStr, 1);
}

function addDays(dateStr, n) {
  return addLocalDays(dateStr, n);
}

function formatWeekLabel(monday) {
  const sunday = addDays(monday, 6);
  return `${formatDate(monday)} – ${formatDate(sunday)}`;
}

function isToday(dateStr) {
  return dateStr === todayKey();
}

function normalizeDayHeaderDateLabel(value) {
  // Some Intl date patterns (notably de-DE's numeric day/month form) end in
  // punctuation: "31.08.". In the compact day header that final stop reads as
  // a stray character. Remove only terminal full-stop variants; internal
  // separators and every locale's day/month ordering remain untouched.
  return String(value ?? '').replace(/[.\uFF0E\u3002]\s*$/u, '');
}

function formatDayDate(dateStr) {
  // Ohne Jahr (Audit F-04): das Wochen-Label in der Nav trägt das Jahr; in den
  // 7 Board-Spalten kollidierte das volle Datum mit dem Wochentagsnamen.
  return normalizeDayHeaderDateLabel(formatDayMonth(dateStr));
}

function mealCategories() {
  return state.categories.filter((c) => !EXCLUDED_MEAL_CATEGORY_NAMES.has(c.name));
}

function recipeMealTypeOptions() {
  return [
    { key: 'breakfast', label: t('meals.typeBreakfast') },
    { key: 'lunch', label: t('meals.typeLunch') },
    { key: 'dinner', label: t('meals.typeDinner') },
    { key: 'snack', label: t('meals.typeSnack') },
  ];
}

function buildRandomMealAssignments({ weekStart, visibleMealTypes, meals, recipes, replaceExisting = false, pick = Math.random }) {
  const assignments = [];
  const deleteMealIds = [];
  const previousDayByMealType = new Map();
  let hasOpenSlot = false;
  let hasCompatibleSlot = false;

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const date = addDays(weekStart, dayOffset);
    let previousRecipeIdSameDay = null;
    for (const mealType of visibleMealTypes) {
      const slotMeals = meals.filter((meal) => meal.date === date && meal.meal_type === mealType);
      if (!replaceExisting && slotMeals.length) continue;
      hasOpenSlot = true;
      const compatible = recipes.filter((recipe) => recipeSupportsMealType(recipe, mealType));
      if (!compatible.length) continue;
      hasCompatibleSlot = true;
      const blockedIds = new Set([previousRecipeIdSameDay, previousDayByMealType.get(mealType)].filter(Boolean));
      const preferred = compatible.filter((recipe) => !blockedIds.has(recipe.id));
      const pool = preferred.length ? preferred : compatible;
      const index = Math.floor(Math.max(0, Math.min(0.999999, Number(pick()) || 0)) * pool.length);
      const recipe = pool[index] || pool[0];
      assignments.push({
        date,
        mealType,
        recipe,
        payload: mealPayloadFromRecipe(recipe, date, mealType),
      });
      previousRecipeIdSameDay = recipe.id;
      previousDayByMealType.set(mealType, recipe.id);
      if (replaceExisting) deleteMealIds.push(...slotMeals.map((meal) => meal.id));
    }
  }

  const reason = assignments.length
    ? null
    : !hasOpenSlot
      ? 'week_full'
      : !hasCompatibleSlot
        ? 'no_compatible_recipes'
        : 'no_assignments';

  return { assignments, deleteMealIds: [...new Set(deleteMealIds)], reason };
}

// --------------------------------------------------------
// API-Wrapper
// --------------------------------------------------------

async function loadWeek(week) {
  const currentWeek = getMondayOf(week);
  state.currentWeek = currentWeek;
  try {
    const res = await api.get(`/meals?week=${currentWeek}`);
    state.meals     = Array.isArray(res.data) ? res.data : [];
    state.loadError = null;
  } catch (err) {
    console.error('[Meals] loadWeek Fehler:', err);
    state.meals     = [];
    // Der Fehler wird bis zum Renderer getragen statt in einen Toast gelegt.
    // Ein Toast verschwindet nach Sekunden, der falsche Leerzustand darunter
    // blieb stehen - von den beiden Meldungen überlebte also genau die
    // irreführende (Critique P0, 2026-07-30).
    state.loadError = err;
  }
}

async function loadLists() {
  try {
    const res   = await api.get('/shopping');
    state.lists = res.data;
  } catch {
    state.lists = [];
  }
}

async function loadCategories() {
  try {
    const res       = await api.get('/shopping/categories');
    state.categories = res.data;
  } catch {
    state.categories = [];
  }
}

async function loadRecipes() {
  try {
    const res = await api.get('/recipes');
    state.recipes = res.data;
  } catch {
    state.recipes = [];
  }
}

async function loadPreferences() {
  try {
    const res = await api.get('/preferences');
    state.visibleMealTypes = res.data.visible_meal_types ?? state.visibleMealTypes;
  } catch {
    // Default beibehalten
  }
}

async function loadPlanning() {
  try {
    const res = await api.get('/meals/planning');
    state.planning = res.data || { timing_defaults: [], slots: [], members: [], execution_settings: null };
  } catch {
    state.planning = { timing_defaults: [], slots: [], members: [], execution_settings: null };
  }
}

async function loadSelectionRequests() {
  try {
    const res = await api.get('/meals/selection-requests');
    state.selectionRequests = Array.isArray(res.data) ? res.data : [];
  } catch {
    state.selectionRequests = [];
  }
}

function parseMealRouteState(defaultWeek) {
  let params;
  try { params = new URLSearchParams(window.location.search); } catch { params = new URLSearchParams(); }
  const requestedDate = params.get('week') || params.get('start') || params.get('date') || defaultWeek;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(String(requestedDate)) ? requestedDate : defaultWeek;
  const member = Number(params.get('member') || params.get('member_id'));
  const rawContext = params.get('context') || params.get('context_id') || params.get('planning_context_id');
  const context = Number(rawContext);
  const primaryMode = params.get('mode') || params.get('view');
  state.currentWeek = getMondayOf(validDate);
  state.mode = ['status', 'meal-status', 'status-view'].includes(primaryMode) ? 'status' : 'choices';
  state.viewMode = params.get('layout') === 'timeline' ? 'timeline' : 'week';
  state.selectedMemberId = Number.isFinite(member) && member > 0 ? member : state.currentUserId;
  state.selectedContextId = rawContext === 'home'
    ? 'home'
    : Number.isFinite(context) && context > 0 ? context : null;
  state.deepLinkOpenKey = params.get('open') || params.get('occurrence');
  state.deepLinkFocus = params.get('focus');
}

function syncMealRouteState({ replace = true } = {}) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('week', state.currentWeek);
    url.searchParams.set('mode', state.mode);
    if (state.viewMode === 'timeline') url.searchParams.set('layout', 'timeline');
    else url.searchParams.delete('layout');
    if (state.selectedMemberId && Number(state.selectedMemberId) !== Number(state.currentUserId)) {
      url.searchParams.set('member', String(state.selectedMemberId));
      url.searchParams.delete('member_id');
    } else {
      url.searchParams.delete('member');
      url.searchParams.delete('member_id');
    }
    if (state.selectedContextId === 'home') {
      url.searchParams.set('context', 'home');
      url.searchParams.delete('context_id');
      url.searchParams.delete('planning_context_id');
    } else if (selectedNumericContextId()) {
      url.searchParams.set('context', String(state.selectedContextId));
      url.searchParams.delete('context_id');
      url.searchParams.delete('planning_context_id');
    } else {
      url.searchParams.delete('context');
      url.searchParams.delete('context_id');
      url.searchParams.delete('planning_context_id');
    }
    if (state.deepLinkOpenKey) url.searchParams.set('open', state.deepLinkOpenKey);
    else url.searchParams.delete('open');
    window.history[replace ? 'replaceState' : 'pushState'](window.history.state, '', url);
  } catch { /* URL state is progressive enhancement. */ }
}

function weekModelQuery({ member = true } = {}) {
  const params = new URLSearchParams({
    start: state.currentWeek,
    end: addDays(state.currentWeek, 6),
  });
  if (member && state.selectedMemberId) params.set('member_id', String(state.selectedMemberId));
  if (selectedNumericContextId()) params.set('context_id', String(state.selectedContextId));
  return params.toString();
}

function selectedNumericContextId() {
  const value = Number(state.selectedContextId);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function mealMatchesSelectedContext(meal) {
  if (state.selectedContextId === 'home') return !meal?.planning_context_id;
  const contextId = selectedNumericContextId();
  if (contextId) return Number(meal?.planning_context_id) === contextId;
  return true;
}

async function loadWeekExperience() {
  const [choicesResult, statusResult] = await Promise.allSettled([
    api.get(`/meals/week-model?${weekModelQuery()}`),
    api.get(`/meals/status?${weekModelQuery({ member: false })}`),
  ]);

  if (choicesResult.status === 'fulfilled') {
    state.weekModel = normalizeMealWeekModel(choicesResult.value, {
      currentUserId: state.currentUserId,
      selectedMemberId: state.selectedMemberId,
    });
    state.weekModelError = null;
    if (!state.selectedMemberId && state.weekModel.selected_member_id) {
      state.selectedMemberId = state.weekModel.selected_member_id;
    }
    const open = state.deepLinkOpenKey;
    const match = open && state.weekModel.occurrences.find((occurrence) =>
      occurrence.key === open || String(occurrence.id) === String(open));
    if (match) state.expandedOccurrences.add(match.key);
  } else {
    state.weekModel = null;
    state.weekModelError = choicesResult.reason;
  }

  if (statusResult.status === 'fulfilled') {
    state.statusModel = normalizeMealStatusModel(statusResult.value, {
      currentUserId: state.currentUserId,
    });
    state.statusModelError = null;
  } else {
    state.statusModel = null;
    state.statusModelError = statusResult.reason;
  }
}

function legacyWeekModel() {
  return normalizeMealWeekModel({
    members: state.planning.members || [],
    selected_member_id: state.selectedMemberId,
    occurrences: state.meals.map((meal) => ({
      id: meal.id,
      date: meal.date,
      meal_type: meal.meal_type,
      meal,
      participants: meal.participants || [],
      applicable: true,
      can_act_for: false,
      controls: {
        choose_shared_meal: false,
        choose_personal_meal: false,
        set_participation: false,
        choose_backup: false,
        skip: false,
        add_notes: false,
      },
      unavailable_reason: state.weekModelError
        ? mealText('meals.weekModelReadOnly', 'Choices are temporarily read-only because personalized meal planning could not be loaded.')
        : null,
      context: {
        id: meal.planning_context_id,
        name: meal.context_name || meal.place_name || 'Home',
        type: meal.context_type || 'home',
      },
    })),
  }, { currentUserId: state.currentUserId, selectedMemberId: state.selectedMemberId });
}

function stableMealDeviceKey() {
  if (!isWallModeEnabled()) return null;
  try {
    const key = 'yuvomi-meal-decision-device';
    let value = localStorage.getItem(key);
    if (!value) {
      value = `web-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
      localStorage.setItem(key, value);
    }
    return value;
  } catch {
    return null;
  }
}

// --------------------------------------------------------
// Render
// --------------------------------------------------------

export async function render(container, { user }) {
  _container = container;
  state.isAdmin = user?.role === 'admin';
  state.currentUserId = Number(user?.id) || null;
  state.expandedOccurrences = new Set();
  state.expandedStatusOptions = new Set();
  state.desktopOccurrenceDialogKey = null;
  state.weekModel = null;
  state.statusModel = null;
  const today  = todayKey();
  const monday = getMondayOf(today);
  parseMealRouteState(monday);
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="meals-page">
      <h1 class="sr-only">${t('nav.meals')}</h1>
      <div class="meal-view-bar">
        <div class="segmented meal-primary-tabs" role="tablist" aria-label="${mealText('meals.viewLabel', 'Meal view')}">
          <button class="segmented__item" id="meal-view-choices" role="tab"
                  aria-selected="${state.mode === 'choices'}" aria-controls="week-grid"
                  tabindex="${state.mode === 'choices' ? '0' : '-1'}">
            <i data-lucide="circle-user-round" class="icon-sm" aria-hidden="true"></i>
            <span>${mealText('meals.myChoices', 'My Choices')}</span>
          </button>
          <button class="segmented__item" id="meal-view-status" role="tab"
                  aria-selected="${state.mode === 'status'}" aria-controls="week-grid"
                  tabindex="${state.mode === 'status' ? '0' : '-1'}">
            <i data-lucide="users-round" class="icon-sm" aria-hidden="true"></i>
            <span>${mealText('meals.mealStatus', 'Meal Status')}</span>
          </button>
        </div>
        <div class="meal-view-filters">
          <label class="meal-member-filter" for="meal-member-select">
            <span>${mealText('meals.memberLabel', 'Person')}</span>
            <select class="form-input" id="meal-member-select" aria-label="${mealText('meals.memberLabel', 'Person')}">
              <option value="${state.selectedMemberId || ''}">${esc(user?.display_name || user?.username || mealText('meals.meLabel', 'Me'))}</option>
            </select>
          </label>
          <label class="meal-context-filter" for="meal-context-select" hidden>
            <span>${mealText('meals.contextLabel', 'Planning context')}</span>
            <select class="form-input" id="meal-context-select"></select>
          </label>
        </div>
      </div>
      <div class="meal-acting-banner" id="meal-acting-banner" role="status" hidden></div>
      <!-- Kanonischer Kopf, Gruppen-Variante (.page-toolbar--in-group in
           layout.css): Akzentstreifen und oberste Sticky-Position bleiben bei
           der .kitchen-tabs-bar darüber. Vorher war das hier eine eigene
           .week-nav-Grammatik, eine von vier im Modul (Critique 2026-07-29).

           Die Datums-Navigation liegt geschlossen im __center-Slot. Vorher
           standen „<" und „>" an den beiden Enden der Zeile, mit dem gesamten
           Aktionsblock dazwischen - mobil gemessen 80px und 705px, einhändig
           also nie beide erreichbar. -->
      <div class="page-toolbar page-toolbar--in-group page-toolbar--wrap">
        <div class="page-toolbar__center week-nav">
          <button class="btn btn--icon" id="week-prev" aria-label="${t('meals.prevWeek')}">
            <i data-lucide="chevron-left" aria-hidden="true"></i>
          </button>
          <span class="week-nav__label" id="week-label"></span>
          <button class="btn btn--icon" id="week-next" aria-label="${t('meals.nextWeek')}">
            <i data-lucide="chevron-right" aria-hidden="true"></i>
          </button>
          <button class="btn btn--secondary week-nav__today" id="week-today">${t('meals.today')}</button>
        </div>
        <div class="page-toolbar__actions">
          <button class="btn btn--secondary" id="meal-view-toggle" aria-pressed="${state.viewMode === 'timeline'}"><i data-lucide="${state.viewMode === 'timeline' ? 'layout-grid' : 'list'}" class="icon-sm" aria-hidden="true"></i><span>${state.viewMode === 'timeline' ? mealText('meals.weeklyGrid', 'Weekly grid') : mealText('meals.timeline', 'Timeline')}</span></button>
          <button class="btn btn--secondary" id="meal-choice-requests" hidden><i data-lucide="inbox" class="icon-sm" aria-hidden="true"></i><span>${mealText('meals.pendingRequests', 'Pending requests')}</span><span class="meal-request-count" aria-hidden="true"></span></button>
          <button class="btn btn--secondary" id="meal-plan-manage"><i data-lucide="notebook-tabs" class="icon-sm" aria-hidden="true"></i><span>${mealText('meals.mealPlans', 'Meal Plans')}</span></button>
          <button class="btn btn--secondary" id="meal-prepare-week"><i data-lucide="list-checks" class="icon-sm" aria-hidden="true"></i><span>${t('meals.prepareWeek')}</span></button>
          <!-- Nur Desktop: klappt die Rezept-Spalte weg, damit alle sieben
               Tagesspalten in voller Breite ins Board passen. -->
          <button class="btn btn--icon week-nav__rail-toggle" id="rail-toggle"
                  aria-expanded="true" aria-controls="recipe-sidebar"
                  aria-label="${t('meals.hideRecipes')}" title="${t('meals.hideRecipes')}">
            <i data-lucide="panel-right-close" class="icon-md" aria-hidden="true"></i>
          </button>
          <!-- Zuletzt und als Ghost: der Zufallsplan kann 28 Slots umschreiben,
               stand aber im teuersten Pixel des Kopfes direkt neben „Heute" -
               in der Gewichtung eines Datumssprungs (Critique 2026-07-29). Er
               bleibt erreichbar, führt den Kopf aber nicht mehr an. -->
        </div>
      </div>
      <div class="meals-layout">
        <div class="week-grid page-scrollport" id="week-grid" role="tabpanel" aria-labelledby="meal-view-${state.mode}">
          <div style="grid-column:1/-1">${renderSkeletonList({ rows: 5, lines: 2 })}</div>
        </div>
        <aside class="recipe-sidebar" id="recipe-sidebar"></aside>
      </div>
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: container });
  renderKitchenTabsBar(container, '/meals');

  await Promise.all([
    loadWeek(state.currentWeek), loadLists(), loadPreferences(), loadCategories(),
    loadRecipes(), loadPlanning(), loadSelectionRequests(), loadWeekExperience(),
  ]);
  renderWeekExperienceHeader();
  renderWeekGrid();
  renderRecipeSidebar();
  wireNav();
  wireRecipeSidebar();
  wireRailToggle();
  syncMealRouteState();
  if (state.deepLinkFocus === 'meal-plan') {
    requestAnimationFrame(() => openMealPlanManager());
  }

}

// --------------------------------------------------------
// Rezept-Spalte ein-/ausklappen
// --------------------------------------------------------

const RAIL_STORAGE_KEY = 'yuvomi-meals-rail';

/**
 * Klappt die Rezept-Spalte weg. Sie belegt auf 1024-1439px 272px und ab 1440px
 * 320px - genau die Breite, die dem Board für den siebten Tag fehlt: mit ihr
 * sind Samstag und Sonntag nur über horizontales Scrollen erreichbar, ohne sie
 * passen alle sieben Spalten in voller Breite (Critique 2026-07-29). Die
 * Mindestbreite der Tagesspalten bleibt unangetastet, damit die Namen nicht
 * wieder silbenweise brechen (siehe Kommentar an .week-grid in meals.css).
 */
function wireRailToggle() {
  const btn = _container.querySelector('#rail-toggle');
  const layout = _container.querySelector('.meals-layout');
  if (!btn || !layout) return;

  const apply = (hidden) => {
    layout.classList.toggle('meals-layout--rail-hidden', hidden);
    btn.setAttribute('aria-expanded', String(!hidden));
    const label = hidden ? t('meals.showRecipes') : t('meals.hideRecipes');
    btn.setAttribute('aria-label', label);
    btn.title = label;
    const icon = btn.querySelector('i, svg');
    if (icon) {
      icon.remove();
      btn.insertAdjacentHTML('afterbegin',
        `<i data-lucide="${hidden ? 'panel-right-open' : 'panel-right-close'}" class="icon-md" aria-hidden="true"></i>`);
      if (window.lucide) lucide.createIcons({ el: btn });
    }
  };

  // Default: gemessen, nicht per Breakpoint.
  //
  // Die Rezept-Spalte kostet 272-320px - genau die Breite, die dem Board für
  // die letzten Tage fehlt. Mit ihr zeigte das Board gemessen 4 von 7 Tagen
  // (Critique 2026-07-30). Eine px-Schwelle wäre hier die falsche Antwort: die
  // Zahl der Spalten hängt an den sichtbaren Mahlzeitstypen, und Zoom sowie
  // Schriftgröße verschieben sie zusätzlich. Stattdessen die Frage stellen, um
  // die es geht - passt die Woche mit offener Spalte? -, und nur dann
  // einklappen. Eine bewusste Entscheidung des Nutzers überschreibt den
  // Default dauerhaft (localStorage).
  let hidden = false;
  let gespeichert = null;
  try { gespeichert = localStorage.getItem(RAIL_STORAGE_KEY); } catch { /* ignore */ }
  if (gespeichert) {
    hidden = gespeichert === 'hidden';
  } else {
    const grid = _container.querySelector('#week-grid');
    const desktop = !window.matchMedia?.('(max-width: 640px)').matches;
    hidden = Boolean(desktop && grid && grid.scrollWidth > grid.clientWidth + 1);
  }
  apply(hidden);

  btn.addEventListener('click', () => {
    hidden = !layout.classList.contains('meals-layout--rail-hidden');
    apply(hidden);
    try { localStorage.setItem(RAIL_STORAGE_KEY, hidden ? 'hidden' : 'shown'); } catch { /* ignore */ }
  });
}

// --------------------------------------------------------
// Wochengitter
// --------------------------------------------------------

function activeWeekModel() {
  if (state.mode === 'status') return state.statusModel || state.weekModel || legacyWeekModel();
  return state.weekModel || legacyWeekModel();
}

function selectedMealMember(model = activeWeekModel()) {
  return (model.members || []).find((member) => Number(member.id) === Number(state.selectedMemberId)) || null;
}

function canActForSelectedMember(model = activeWeekModel()) {
  if (Number(state.selectedMemberId) === Number(state.currentUserId)) return true;
  const member = selectedMealMember(model);
  return Boolean(model.can_act_for || member?.can_act_for);
}

function usesDesktopOccurrenceDialog() {
  return Boolean(window.matchMedia?.('(min-width: 1024px)').matches);
}

/**
 * Keep the on-behalf-of disclosure at both levels where a choice can be made:
 * in the week header and inside the desktop choice dialog. The actor wording
 * is deliberately explicit because the beneficiary and the account/device
 * that submitted the decision are separate audit identities on the server.
 */
function mealActingForNotice(model = activeWeekModel()) {
  const member = selectedMealMember(model);
  if (!member || Number(member.id) === Number(state.currentUserId) || state.mode !== 'choices') return null;
  const canAct = canActForSelectedMember(model);
  return {
    canAct,
    icon: canAct ? 'user-round-cog' : 'eye',
    message: canAct
      ? mealText('meals.actingFor', 'Acting for {{name}}. Your account remains the recorded actor.', { name: member.display_name })
      : mealText('meals.viewingFor', 'Viewing {{name}}. Choices are read-only.', { name: member.display_name }),
  };
}

function renderMealActingForNotice(model = activeWeekModel(), modifier = '') {
  const notice = mealActingForNotice(model);
  if (!notice) return '';
  return `<div class="meal-acting-banner${notice.canAct ? '' : ' meal-acting-banner--readonly'}${modifier ? ` ${modifier}` : ''}" role="status">
    <i data-lucide="${notice.icon}" class="icon-sm" aria-hidden="true"></i>
    <span>${esc(notice.message)}</span>
  </div>`;
}

function collectMealContexts(model) {
  const seen = new Set();
  return [...(model.contexts || []), ...(model.occurrences || []).map((occurrence) => occurrence.context)]
    .filter((context) => {
      if (!context?.id || seen.has(Number(context.id))) return false;
      seen.add(Number(context.id));
      return true;
    });
}

function mealMutationContext() {
  if (state.selectedContextId === 'home') return { allowed: true, id: null };
  const id = selectedNumericContextId();
  if (id) return { allowed: true, id };
  const hasTravelContexts = collectMealContexts(activeWeekModel()).length > 0;
  return { allowed: !hasTravelContexts, id: null };
}

function openMealForSelectedContext(options) {
  const context = mealMutationContext();
  if (!context.allowed) {
    window.yuvomi?.showToast(
      mealText('meals.chooseContextBeforeEditing', 'Choose Home or a trip before changing this week.'),
      'warning',
    );
    return;
  }
  openMealModal({ ...options, planningContextId: context.id });
}

function renderWeekExperienceHeader() {
  if (!_container) return;
  const model = activeWeekModel();
  const choicesTab = _container.querySelector('#meal-view-choices');
  const statusTab = _container.querySelector('#meal-view-status');
  [[choicesTab, 'choices'], [statusTab, 'status']].forEach(([tab, mode]) => {
    if (!tab) return;
    const active = state.mode === mode;
    tab.setAttribute('aria-selected', String(active));
    tab.classList.toggle('is-active', active);
    tab.tabIndex = active ? 0 : -1;
  });

  const grid = _container.querySelector('#week-grid');
  grid?.setAttribute('aria-labelledby', `meal-view-${state.mode}`);
  const requestButton = _container.querySelector('#meal-choice-requests');
  if (requestButton) {
    const count = state.selectionRequests.length;
    requestButton.hidden = count === 0;
    requestButton.querySelector('.meal-request-count').textContent = String(count);
    requestButton.setAttribute('aria-label', mealText(
      'meals.pendingRequestsCount',
      '{{count}} pending meal choice requests',
      { count },
    ));
  }

  const memberLabel = _container.querySelector('.meal-member-filter');
  const memberSelect = _container.querySelector('#meal-member-select');
  if (memberLabel) memberLabel.hidden = state.mode === 'status';
  if (memberSelect && state.mode === 'choices') {
    const members = model.members?.length
      ? model.members
      : (state.planning.members || []).map((member) => ({
          ...member,
          display_name: member.display_name || member.name,
        }));
    if (!members.some((member) => Number(member.id) === Number(state.selectedMemberId))) {
      state.selectedMemberId = state.currentUserId || members[0]?.id || null;
    }
    memberSelect.replaceChildren();
    members.forEach((member) => {
      const option = document.createElement('option');
      option.value = String(member.id);
      option.textContent = member.display_name || member.name || mealText('meals.householdMember', 'Household member');
      option.selected = Number(member.id) === Number(state.selectedMemberId);
      memberSelect.appendChild(option);
    });
    memberLabel.hidden = members.length <= 1;
  }

  const contexts = collectMealContexts(model);
  const contextLabel = _container.querySelector('.meal-context-filter');
  const contextSelect = _container.querySelector('#meal-context-select');
  if (contextLabel && contextSelect) {
    contextLabel.hidden = contexts.length === 0;
    contextSelect.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = mealText('meals.allContexts', 'All contexts');
    all.selected = state.selectedContextId == null;
    contextSelect.appendChild(all);
    const home = document.createElement('option');
    home.value = 'home';
    home.textContent = mealText('meals.homeContext', 'Home');
    home.selected = state.selectedContextId === 'home';
    contextSelect.appendChild(home);
    contexts.forEach((context) => {
      const option = document.createElement('option');
      option.value = String(context.id);
      option.textContent = context.name || mealText('meals.homeContext', 'Home');
      option.selected = Number(context.id) === Number(state.selectedContextId);
      contextSelect.appendChild(option);
    });
  }
  const banner = _container.querySelector('#meal-acting-banner');
  if (banner) {
    const notice = mealActingForNotice(model);
    banner.hidden = !notice;
    if (notice) {
      banner.classList.toggle('meal-acting-banner--readonly', !notice.canAct);
      banner.replaceChildren();
      banner.insertAdjacentHTML('beforeend', `
        <i data-lucide="${notice.icon}" class="icon-sm" aria-hidden="true"></i>
        <span>${esc(notice.message)}</span>
      `);
      if (window.lucide) lucide.createIcons({ el: banner });
    }
  }
}

function occurrenceDomId(occurrence) {
  return `meal-occurrence-${String(occurrence.key).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function mealTypeLabel(type) {
  return MEAL_TYPES().find((item) => item.key === type)?.label || type || mealText('meals.mealLabel', 'Meal');
}

function policyLabel(policy) {
  return {
    fixed: mealText('meals.policyFixed', 'Fixed chooser'),
    round_robin: mealText('meals.policyRoundRobin', 'Round robin'),
    personal_choice: mealText('meals.policyPersonalChoice', 'Personal Choice'),
  }[policy] || policy;
}

function participationLabel(value) {
  return {
    participating: mealText('meals.participating', 'Participating'),
    not_participating: mealText('meals.skipped', 'Skipped'),
    away: mealText('meals.away', 'Away'),
    pending: mealText('meals.pendingResponse', 'Response pending'),
  }[value] || mealText('meals.pendingResponse', 'Response pending');
}

function chooserStatusLabel(value) {
  return {
    pending: mealText('meals.chooserPending', 'Choice pending'),
    accepted: mealText('meals.chooserAccepted', 'Chooser confirmed'),
    fulfilled: mealText('meals.chooserFulfilled', 'Meal selected'),
    declined: mealText('meals.chooserDeclined', 'Responsibility declined'),
    timed_out: mealText('meals.chooserTimedOut', 'Choice overdue'),
    reassigned: mealText('meals.chooserReassigned', 'Chooser reassigned'),
    needs_fallback: mealText('meals.chooserNeedsFallback', 'Chooser needed'),
  }[value] || String(value || mealText('meals.pending', 'Pending'));
}

function mealTimeLabel(occurrence) {
  if (occurrence.earliest_time || occurrence.latest_time) {
    return [occurrence.earliest_time, occurrence.latest_time].filter(Boolean).join(' - ');
  }
  return occurrence.scheduled_time || '';
}

function renderPersonList(people) {
  if (!people?.length) return `<span class="meal-person-list__empty">${mealText('meals.noPeople', 'No one yet')}</span>`;
  return `<ul class="meal-person-list">${people.map((person) => `
    <li>${person.avatar_data ? `<img src="${esc(person.avatar_data)}" alt="">` : `<span class="meal-person-list__avatar" aria-hidden="true">${esc((person.display_name || '?').slice(0, 1))}</span>`}<span>${esc(person.display_name || mealText('meals.householdMember', 'Household member'))}</span></li>
  `).join('')}</ul>`;
}

function legacyMealForOccurrence(occurrence) {
  const id = Number(occurrence.meal?.id || occurrence.id);
  return state.meals.find((meal) => Number(meal.id) === id) || occurrence.meal;
}

function renderOccurrenceActions(occurrence) {
  const meal = legacyMealForOccurrence(occurrence);
  if (!meal?.id) return '';
  const activeConflicts = (meal.calendar_conflicts || []).filter((conflict) => conflict.active);
  const ownCount = meal.ingredients?.length ?? 0;
  const recipeCount = ownCount === 0 ? (meal.recipe_ingredient_count ?? 0) : 0;
  const canTransfer = recipeCount > 0 || (ownCount > 0 && meal.ingredients.some((ingredient) => !ingredient.on_shopping_list));
  const title = meal.title || occurrence.slot_label || mealTypeLabel(occurrence.meal_type);
  return `<div class="meal-choice-card__actions" aria-label="${esc(mealText('meals.mealActions', 'Meal actions'))}">
    ${meal.selection_status === 'selected' ? `<button class="meal-card__action-btn" data-action="meal-execution" data-meal-id="${meal.id}" aria-label="${esc(t('meals.executionButtonNamed', { title }))}"><i data-lucide="list-checks" class="icon-sm" aria-hidden="true"></i></button>` : ''}
    ${activeConflicts.length ? `<button class="meal-card__action-btn" data-action="resolve-conflicts" data-meal-id="${meal.id}" aria-label="${esc(mealText('meals.reviewConflictsNamed', 'Review Calendar conflicts for {{title}}', { title }))}"><i data-lucide="triangle-alert" class="icon-sm" aria-hidden="true"></i></button>` : ''}
    ${meal.recipe_url ? `<a class="meal-card__action-btn meal-card__action-btn--recipe" data-action="open-recipe" href="${esc(meal.recipe_url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(t('meals.openRecipeNamed', { title }))}"><i data-lucide="link" class="icon-sm" aria-hidden="true"></i></a>` : ''}
    ${canTransfer ? `<button class="meal-card__action-btn meal-card__action-btn--shopping" data-action="transfer-meal" data-meal-id="${meal.id}" aria-label="${esc(t('common.toShoppingListNamed', { title }))}"><i data-lucide="shopping-cart" class="icon-sm" aria-hidden="true"></i></button>` : ''}
    <button class="meal-card__action-btn" data-action="edit-meal" data-meal-id="${meal.id}" aria-label="${esc(t('meals.editMeal'))}"><i data-lucide="pencil" class="icon-sm" aria-hidden="true"></i></button>
    <button class="meal-card__action-btn" data-action="delete-meal" data-meal-id="${meal.id}" aria-label="${esc(t('meals.deleteMealNamed', { title }))}"><i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i></button>
  </div>`;
}

function renderCookingSummary(occurrence) {
  const cooks = occurrence.cooks || [];
  const supervisors = occurrence.supervisors || [];
  if (!cooks.length && !supervisors.length) {
    return `<span class="meal-detail-value meal-detail-value--muted">${mealText('meals.notAssigned', 'Not assigned')}</span>`;
  }
  return `<span class="meal-detail-value">${[
    ...cooks.map((person) => `${person.display_name} (${mealText('meals.cook', 'cook')})`),
    ...supervisors.map((person) => `${person.display_name} (${mealText('meals.supervisor', 'supervision')})`),
  ].map(esc).join(', ')}</span>`;
}

function occurrenceSelectionPolicy(occurrence) {
  return occurrence.rule?.policy || occurrence.policy || occurrence.selection_policy || 'fixed';
}

function selectedMemberIsOccurrenceChooser(occurrence) {
  // Fail closed when an occurrence has exhausted or is between chooser
  // assignments. A stale participant role or stale client control must never
  // make the selected member look like the active chooser.
  if (!occurrenceHasActiveChooser(occurrence)) return false;
  if (occurrence.controls?.choose_shared_meal === false) return false;
  const selectedMemberId = Number(state.selectedMemberId);
  if (Number(occurrence.chooser?.user_id ?? occurrence.chooser?.id) === selectedMemberId) return true;
  return (occurrence.participants || []).some((person) => (
    Number(person.user_id ?? person.id) === selectedMemberId
      && (person.is_chooser || person.roles?.includes('chooser'))
  ));
}

function occurrenceHasActiveChooser(occurrence) {
  if (occurrenceSelectionPolicy(occurrence) === 'personal_choice') return true;
  const chooserId = Number(occurrence.chooser?.user_id ?? occurrence.chooser?.id);
  if (!Number.isFinite(chooserId) || chooserId <= 0) return false;
  const inactiveStatuses = new Set(['declined', 'timed_out', 'needs_fallback', 'unassigned']);
  return !inactiveStatuses.has(String(occurrence.chooser_status || '').toLowerCase());
}

function occurrenceMealTitle(occurrence) {
  // An unassigned household meal has no food yet. Showing "Pending" as the
  // meal name made it look as though a menu already existed and merely needed
  // approval.
  if (!occurrenceHasActiveChooser(occurrence)) return '';
  return mealDisplayTitle(occurrence, mealText('meals.pending', 'Pending'));
}

function renderChooserRepairAction(occurrence) {
  const mealId = Number(occurrence?.meal?.id || occurrence?.id);
  if (!state.isAdmin || !mealId || occurrenceSelectionPolicy(occurrence) === 'personal_choice'
      || occurrenceHasActiveChooser(occurrence)) return '';
  return `<div class="meal-chooser-repair">
    <span><strong>${mealText('meals.chooserRepairTitle', 'This meal needs a chooser')}</strong><small>${mealText('meals.chooserRepairHint', 'Continue through the configured backup chain or use the household failsafe.')}</small></span>
    <button type="button" class="btn btn--secondary btn--sm" data-action="repair-meal-chooser" data-meal-id="${mealId}" data-occurrence-key="${esc(occurrence.key)}"><i data-lucide="user-round-check" class="icon-sm" aria-hidden="true"></i>${mealText('meals.assignNextChooser', 'Assign next chooser')}</button>
  </div>`;
}

function renderChoiceForm(occurrence, decision, canAct) {
  const mealId = occurrence.meal?.id || occurrence.id;
  if (!canAct || !mealId || occurrence.unavailable_reason) return '';
  const controls = occurrence.controls || {};
  const explicitControls = Object.keys(controls).length > 0;
  const policy = occurrenceSelectionPolicy(occurrence);
  const personalPolicy = policy === 'personal_choice';
  const chooserMode = !personalPolicy && selectedMemberIsOccurrenceChooser(occurrence)
    && (!explicitControls || controls.choose_shared_meal);
  const allowParticipation = !explicitControls || controls.set_participation;
  const allowPersonal = personalPolicy && (!explicitControls || controls.choose_personal_meal);
  const allowBackup = !personalPolicy && !chooserMode && (!explicitControls || controls.choose_backup);
  const allowNotes = !explicitControls || controls.add_notes;
  const allowSkip = !explicitControls || controls.skip;
  if (![allowParticipation, chooserMode, allowPersonal, allowBackup, allowNotes, allowSkip].some(Boolean)) return '';
  const selectedIds = new Set(selectedMenuItems(occurrence, decision).map((item) => Number(item.id)));
  const courseLimits = mealCourseLimits(occurrence);
  const entreeItems = chooserMode ? occurrence.menu_items.filter((item) => item.kind === 'entree') : [];
  const sideItems = chooserMode ? occurrence.menu_items.filter((item) => item.kind === 'side') : [];
  const personalKinds = new Set(['personal', 'restaurant', 'takeout']);
  const personalKind = personalKinds.has(decision?.choice_kind) ? decision.choice_kind : 'personal';
  const personalRecipeOptions = state.recipes
    .filter((recipe) => recipeAllowsMealType(recipe, occurrence.meal_type))
    .map((recipe) => `<option value="${esc(recipe.title)}"></option>`)
    .join('');
  const recipeListId = `${occurrenceDomId(occurrence)}-recipes`;
  const backupSelected = decision?.choice_kind === 'backup' && decision?.is_current_choice !== false;
  const backupMealTitle = backupSelected ? (decision?.selected_meal_title || '') : '';
  const ownPendingObligation = (occurrence.chooser_obligations || []).find((obligation) => (
    Number(obligation.responsible_user_id) === Number(state.currentUserId)
      && Number(state.selectedMemberId) === Number(state.currentUserId)
      && ['pending', 'accepted'].includes(obligation.status)
  ));
  const participation = decision?.participation || 'participating';
  const memberIsCook = [...occurrence.cooks, ...occurrence.supervisors]
    .some((person) => Number(person.user_id ?? person.id) === Number(state.selectedMemberId));
  return `<form class="meal-choice-form" data-meal-decision data-meal-id="${mealId}" data-occurrence-key="${esc(occurrence.key)}" data-choice-surface="${personalPolicy ? 'personal' : chooserMode ? 'chooser' : 'backup'}" data-max-side-choices="${courseLimits.max_side_choices}">
    <datalist id="${recipeListId}">${personalRecipeOptions}</datalist>
    ${allowParticipation ? `<fieldset class="meal-choice-form__section">
      <legend>${mealText('meals.participationTitle', 'Participation')}</legend>
      <label class="meal-inline-choice"><input type="radio" name="participation" value="participating" ${participation !== 'not_participating' ? 'checked' : ''}><span>${mealText('meals.joinMeal', 'I will join this meal')}</span></label>
      <label class="meal-inline-choice"><input type="radio" name="participation" value="not_participating" ${participation === 'not_participating' ? 'checked' : ''}><span>${mealText('meals.notJoiningMeal', 'I will not join')}</span></label>
    </fieldset>` : `<input type="hidden" name="participation" value="${esc(participation)}">`}
    ${chooserMode ? `<fieldset class="meal-choice-form__section" data-meal-food-section ${participation === 'not_participating' ? 'disabled' : ''}>
      <legend>${mealText('meals.householdMeal', 'Household meal')}</legend>
      <p class="form-hint">${mealText('meals.entree', 'Entrée')}: ${courseLimits.max_entree_choices > 0 ? 1 : 0} · ${mealText('meals.maxSides', 'Maximum sides')}: ${courseLimits.max_side_choices}</p>
      ${entreeItems.map((item) => `<label class="meal-option-choice meal-option-choice--entree"><input type="radio" name="meal_choice" value="${item.id}" ${selectedIds.has(Number(item.id)) ? 'checked' : ''}><span><strong>${esc(item.label)}</strong></span></label>`).join('') || (courseLimits.max_entree_choices > 0 ? `<p class="form-hint">${mealText('meals.noEntreeOptions', 'Use Edit entrée & sides to add the shared meal.')}</p>` : '')}
      ${sideItems.length ? `<div class="meal-side-choices"><span class="meal-side-choices__label">${mealText('meals.maxSides', 'Maximum sides')}: ${courseLimits.max_side_choices}</span>${sideItems.map((item) => `<label class="meal-inline-choice"><input type="checkbox" name="menu_side" value="${item.id}" data-menu-side ${selectedIds.has(Number(item.id)) ? 'checked' : ''}><span>${esc(item.label)}</span></label>`).join('')}</div>` : ''}
    </fieldset>` : ''}
    ${allowBackup ? `<fieldset class="meal-choice-form__section" data-meal-food-section ${participation === 'not_participating' ? 'disabled' : ''}>
      <legend>${mealText('meals.backupChoiceTitle', 'Backup Meal')}</legend>
      <p class="form-hint">${mealText('meals.backupChoiceHint', 'Join the household meal, or choose an individual saved recipe or custom Backup Meal for yourself.')}</p>
      <label class="meal-option-choice meal-option-choice--household"><input type="radio" name="meal_choice" value="household" ${backupSelected ? '' : 'checked'}><span><strong>${mealText('meals.householdMeal', 'Household meal')}</strong><small>${mealText('meals.householdMealHint', 'Use the shared meal instead of Backup Meal')}</small></span></label>
      <label class="meal-option-choice meal-option-choice--backup"><input type="radio" name="meal_choice" value="backup" ${backupSelected ? 'checked' : ''}><span><strong>${mealText('meals.backupMeal', 'Backup Meal')}</strong><small>${mealText('meals.backupChoiceHint', 'Choose an individual meal just for you')}</small></span></label>
      <div class="meal-backup-choice-fields" data-backup-choice-fields>
        <label class="label">${mealText('meals.backupMealChoice', 'Backup meal choice')}<input class="form-input" name="backup_meal_title" list="${recipeListId}" maxlength="300" value="${esc(backupMealTitle)}" placeholder="${esc(mealText('meals.recipeOrCustomPlaceholder', 'Choose a recipe or type a new meal'))}" ${participation === 'not_participating' || !backupSelected ? 'disabled' : ''}><input type="hidden" name="backup_recipe_id" value="${Number(decision?.selected_recipe_id) || ''}"><small class="form-hint">${mealText('meals.backupMealChoiceHint', 'Saved recipes filter as you type; a new meal name is also accepted.')}</small></label>
      </div>
    </fieldset>` : ''}
    ${allowPersonal ? `<fieldset class="meal-choice-form__section" data-meal-food-section ${participation === 'not_participating' ? 'disabled' : ''}>
      <legend>${mealText('meals.personalMeal', 'Personal meal')}</legend>
      <input type="hidden" name="meal_choice" value="personal">
      <p class="form-hint">${mealText('meals.personalMealHint', 'Choose something different for yourself')}</p>
      <div class="meal-personal-choice-fields" data-personal-choice-fields>
        <label class="label">${mealText('meals.personalChoiceType', 'Choice type')}<select class="form-input" name="personal_choice_kind" ${participation === 'not_participating' ? 'disabled' : ''}>
          <option value="personal" ${personalKind === 'personal' ? 'selected' : ''}>${mealText('meals.personalChoiceHome', 'My own meal')}</option>
          <option value="restaurant" ${personalKind === 'restaurant' ? 'selected' : ''}>${mealText('meals.personalChoiceRestaurant', 'Restaurant')}</option>
          <option value="takeout" ${personalKind === 'takeout' ? 'selected' : ''}>${mealText('meals.personalChoiceTakeout', 'Takeout')}</option>
        </select></label>
        <label class="label">${mealText('meals.personalChoiceName', 'What are you having?')}<input class="form-input" name="selected_meal_title" list="${recipeListId}" maxlength="300" value="${esc(decision?.selected_meal_title || '')}" placeholder="${esc(mealText('meals.recipeOrCustomPlaceholder', 'Choose a recipe or type a new meal'))}" ${participation === 'not_participating' ? 'disabled' : ''}><input type="hidden" name="selected_recipe_id" value="${Number(decision?.selected_recipe_id) || ''}"><small class="form-hint">${mealText('meals.recipeOrCustomHintShort', 'Choose a saved recipe or enter a new meal name.')}</small></label>
      </div>
    </fieldset>` : ''}
    ${memberIsCook ? `<p class="form-hint meal-cooking-responsibility"><i data-lucide="chef-hat" class="icon-sm" aria-hidden="true"></i>${mealText('meals.cookingTaskHint', 'Cooking and supervision progress is tracked in the generated Task.')}</p>` : ''}
    ${allowNotes ? `<label class="label">${t('meals.notesLabel')}<textarea class="form-input" name="notes" rows="2" data-meal-notes placeholder="${t('meals.notesPlaceholder')}" ${participation === 'not_participating' ? 'disabled' : ''}>${esc(decision?.notes || '')}</textarea></label>` : ''}
    <div class="meal-choice-form__actions">
      <button type="submit" class="btn btn--primary">${mealText('meals.confirmChoices', 'Confirm choices')}</button>
      ${allowSkip ? `<button type="button" class="btn btn--secondary" data-action="skip-meal-decision" data-meal-id="${mealId}" data-occurrence-key="${esc(occurrence.key)}">${mealText('meals.skipMeal', 'Skip this meal')}</button>` : ''}
      ${ownPendingObligation && !personalPolicy ? `<button type="button" class="btn btn--ghost" data-action="decline-meal-choice" data-obligation-id="${ownPendingObligation.id}">${mealText('meals.declineChooserResponsibility', 'Decline chooser responsibility')}</button>` : ''}
    </div>
    ${allowSkip ? `<p class="form-hint">${chooserMode
    ? mealText('meals.skipChooserResponsibilityHint', 'If you skip or do not participate, Yuvomi passes chooser responsibility to the next configured backup.')
    : mealText('meals.skipResponsibilityHint', 'Skipping records that you will not participate in this meal.')}</p>` : ''}
  </form>`;
}

function canEditOccurrenceMenu(occurrence) {
  return occurrenceSelectionPolicy(occurrence) !== 'personal_choice'
    && selectedMemberIsOccurrenceChooser(occurrence)
    && Boolean(occurrence.controls?.choose_shared_meal || !Object.keys(occurrence.controls || {}).length);
}

function decisionFoodSummary(occurrence, decision) {
  if (!decision) return {
    title: occurrenceMealTitle(occurrence),
    detail: occurrenceHasActiveChooser(occurrence)
      ? mealText('meals.pendingResponse', 'Response pending')
      : mealText('meals.noChooserYet', 'Choose or assign a meal chooser'),
    foods: [],
  };
  if (decision.participation === 'not_participating') {
    return {
      title: mealText('meals.skipped', 'Skipped'),
      detail: mealText('meals.notJoiningMeal', 'Not joining this meal'),
      foods: [],
    };
  }
  if (['personal', 'restaurant', 'takeout'].includes(decision.choice_kind)) {
    const kind = {
      personal: mealText('meals.personalMeal', 'Personal meal'),
      restaurant: mealText('meals.personalChoiceRestaurant', 'Restaurant'),
      takeout: mealText('meals.personalChoiceTakeout', 'Takeout'),
    }[decision.choice_kind];
    const title = decision.selected_meal_title || kind;
    return {
      title,
      detail: kind,
      foods: [{ kind: decision.choice_kind, label: title }],
    };
  }
  const foods = selectedMenuItems(occurrence, decision);
  if (decision.choice_kind === 'backup') {
    const title = decision.selected_meal_title
      || foods.find((item) => item.kind === 'backup')?.label
      || mealText('meals.backupMeal', 'Backup Meal');
    return {
      title,
      detail: mealText('meals.backupMeal', 'Backup Meal'),
      foods: [{ kind: 'backup', label: title }],
    };
  }
  return {
    title: occurrenceMealTitle(occurrence),
    detail: participationLabel(decision.participation),
    foods: occurrenceHasActiveChooser(occurrence) ? foods : [],
  };
}

function renderChoiceOccurrenceDetails(occurrence, model, { includeActingNotice = false } = {}) {
  const decision = decisionForMember(occurrence, state.selectedMemberId);
  const canAct = occurrence.can_act_for ?? canActForSelectedMember(model);
  const summary = decisionFoodSummary(occurrence, decision);
  const chosen = summary.foods;
  const title = summary.title;
  return `${includeActingNotice ? renderMealActingForNotice(model, 'meal-acting-banner--dialog') : ''}
    ${occurrence.unavailable_reason ? `<div class="meal-unavailable"><i data-lucide="calendar-off" class="icon-sm" aria-hidden="true"></i><span>${esc(occurrence.unavailable_reason)}</span></div>` : ''}
    <dl class="meal-role-summary">
      <div><dt>${mealText('meals.chooserResponsibility', 'Chooser responsibility')}</dt><dd><span>${esc(occurrence.chooser?.display_name || mealText('meals.unassigned', 'Unassigned'))}</span><small>${esc(chooserStatusLabel(occurrenceHasActiveChooser(occurrence) ? occurrence.chooser_status : 'needs_fallback'))}</small></dd></div>
      <div><dt>${mealText('meals.participationTitle', 'Participation')}</dt><dd>${esc(participationLabel(decision?.participation))}</dd></div>
      <div><dt>${mealText('meals.foodChoiceTitle', 'Selected food')}</dt><dd>${chosen.length ? chosen.map((item) => `<span class="meal-selected-food meal-selected-food--${esc(item.kind)}">${esc(item.label)}</span>`).join('') : `<span class="meal-detail-value--muted">${esc(title || mealText('meals.noMealSelected', 'No meal selected yet'))}</span>`}</dd></div>
      <div><dt>${mealText('meals.cookingResponsibility', 'Cooking and supervision')}</dt><dd>${renderCookingSummary(occurrence)}</dd></div>
    </dl>
    ${renderChooserRepairAction(occurrence)}
    ${canEditOccurrenceMenu(occurrence) ? `<button type="button" class="btn btn--secondary meal-menu-edit" data-action="edit-meal-menu" data-occurrence-key="${esc(occurrence.key)}"><i data-lucide="list-plus" class="icon-sm" aria-hidden="true"></i>${mealText('meals.editMenuOptions', 'Edit entrée and sides')}</button>` : ''}
    ${renderChoiceForm(occurrence, decision, canAct)}
    ${renderOccurrenceActions(occurrence)}`;
}

function renderChoiceOccurrenceCard(occurrence, model) {
  const expanded = state.expandedOccurrences.has(occurrence.key);
  const inlineExpanded = expanded && !usesDesktopOccurrenceDialog();
  const domId = occurrenceDomId(occurrence);
  const decision = decisionForMember(occurrence, state.selectedMemberId);
  const summary = decisionFoodSummary(occurrence, decision);
  const title = summary.title;
  const context = occurrence.context;
  const detailRelation = usesDesktopOccurrenceDialog()
    ? 'aria-haspopup="dialog"'
    : `aria-controls="${domId}-details"`;
  return `<article class="meal-choice-card ${inlineExpanded ? 'meal-choice-card--expanded' : ''}" data-occurrence-key="${esc(occurrence.key)}" data-date="${esc(occurrence.date)}" data-type="${esc(occurrence.meal_type)}" data-meal-type="${esc(occurrence.meal_type)}" data-context-id="${occurrence.context?.id || ''}" data-generated-plan="${occurrence.plan?.id ? 'true' : 'false'}">
    <header class="meal-choice-card__header">
      <button type="button" class="meal-choice-card__toggle" data-action="toggle-occurrence" data-occurrence-key="${esc(occurrence.key)}" aria-expanded="${inlineExpanded}" ${detailRelation}>
        <span class="meal-choice-card__slot"><strong>${esc(occurrence.slot_label || mealTypeLabel(occurrence.meal_type))}</strong>${mealTimeLabel(occurrence) ? `<small>${esc(mealTimeLabel(occurrence))}</small>` : ''}</span>
        <span class="meal-choice-card__headline">${title ? `<strong>${esc(title)}</strong>` : ''}<small>${esc(summary.detail)}</small></span>
      </button>
      <div class="meal-choice-card__chips">
        ${context?.id && context?.name ? `<span class="meal-context-chip meal-context-chip--${esc(context.type)}"><i data-lucide="${context.type === 'travel' ? 'plane' : 'map-pin'}" class="icon-xs" aria-hidden="true"></i>${esc(context.name)}</span>` : occurrence.place?.name ? `<span class="meal-context-chip meal-context-chip--place"><i data-lucide="map-pin" class="icon-xs" aria-hidden="true"></i>${esc(occurrence.place.name)}</span>` : ''}
        <span class="meal-policy-chip">${esc(policyLabel(occurrence.plan.policy))}</span>
      </div>
    </header>
    ${inlineExpanded ? `<div class="meal-choice-card__details" id="${domId}-details">${renderChoiceOccurrenceDetails(occurrence, model)}</div>` : ''}
  </article>`;
}

function renderStatusOption(occurrence, item) {
  const optionKey = `${occurrence.key}:${item.id ?? item.kind}:${item.position}`;
  const expanded = state.expandedStatusOptions.has(optionKey);
  const peopleId = `${occurrenceDomId(occurrence)}-option-${String(item.id ?? item.position).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  return `<div class="meal-status-option meal-status-option--${esc(item.kind)}">
    <button type="button" data-action="toggle-status-option" data-option-key="${esc(optionKey)}" aria-expanded="${expanded}" aria-controls="${peopleId}">
      <span><strong>${esc(item.label)}</strong><small>${item.kind === 'backup' ? mealText('meals.backupMeal', 'Backup Meal') : mealText('meals.optionType', '{{type}} option', { type: item.kind })}</small></span>
      <span class="meal-status-option__count" aria-label="${esc(mealText('meals.peopleCount', '{{count}} people', { count: item.count }))}">${item.count}</span>
      <i data-lucide="chevron-down" class="icon-sm" aria-hidden="true"></i>
    </button>
    ${expanded ? `<div id="${peopleId}" class="meal-status-option__people">${renderPersonList(item.people)}</div>` : ''}
  </div>`;
}

function statusOccurrenceOptions(occurrence) {
  const hasActiveChooser = occurrenceHasActiveChooser(occurrence);
  const selectionOptions = occurrence.menu_items.filter((item) => (
    !['pending', 'skipped', 'away'].includes(item.kind)
      && (hasActiveChooser || !['entree', 'side', 'household'].includes(item.kind))
      && (item.kind !== 'backup' || Number(item.count || 0) > 0)
  ));
  const fallbackOption = !hasActiveChooser || selectionOptions.length || occurrence.choices?.length ? [] : [{
    id: `meal-${occurrence.meal.id || occurrence.id}`,
    kind: 'entree',
    label: occurrenceMealTitle(occurrence),
    people: occurrence.participants,
    count: occurrence.participants.length,
    position: 0,
  }];
  return [...selectionOptions, ...fallbackOption];
}

function renderStatusOccurrenceDetails(occurrence) {
  const options = statusOccurrenceOptions(occurrence);
  return `<dl class="meal-role-summary">
      <div><dt>${mealText('meals.chooserResponsibility', 'Chooser responsibility')}</dt><dd><span>${esc(occurrence.chooser?.display_name || mealText('meals.unassigned', 'Unassigned'))}</span><small>${esc(chooserStatusLabel(occurrenceHasActiveChooser(occurrence) ? occurrence.chooser_status : 'needs_fallback'))}</small></dd></div>
      <div><dt>${mealText('meals.cookingResponsibility', 'Cooking and supervision')}</dt><dd>${renderCookingSummary(occurrence)}</dd></div>
    </dl>
    ${renderChooserRepairAction(occurrence)}
    <section class="meal-status-options" aria-label="${mealText('meals.mealSelections', 'Meal selections')}">${options.length ? options.map((item) => renderStatusOption(occurrence, item)).join('') : `<p class="form-hint">${mealText('meals.pendingResponse', 'Response pending')}</p>`}</section>
    <div class="meal-status-groups">
      ${occurrence.pending_people.length ? `<details><summary>${mealText('meals.pendingPeople', 'Waiting for response')} (${occurrence.pending_people.length})</summary>${renderPersonList(occurrence.pending_people)}</details>` : ''}
      ${occurrence.skipped_people.length ? `<details><summary>${mealText('meals.skippedPeople', 'Skipped')} (${occurrence.skipped_people.length})</summary>${renderPersonList(occurrence.skipped_people)}</details>` : ''}
      ${occurrence.unavailable_people.length ? `<details><summary>${mealText('meals.unavailablePeople', 'Away or unavailable')} (${occurrence.unavailable_people.length})</summary>${renderPersonList(occurrence.unavailable_people)}</details>` : ''}
    </div>
    ${renderOccurrenceActions(occurrence)}`;
}

function renderStatusOccurrenceCard(occurrence) {
  const expanded = state.expandedOccurrences.has(occurrence.key);
  const inlineExpanded = expanded && !usesDesktopOccurrenceDialog();
  const domId = occurrenceDomId(occurrence);
  const options = statusOccurrenceOptions(occurrence);
  const responded = Number(occurrence.totals?.resolved ?? options.reduce((sum, item) => sum + Number(item.count || 0), 0));
  const total = Number(occurrence.totals?.total ?? occurrence.participants?.length ?? responded);
  const detailRelation = usesDesktopOccurrenceDialog()
    ? 'aria-haspopup="dialog"'
    : `aria-controls="${domId}-details"`;
  return `<article class="meal-choice-card meal-status-card ${inlineExpanded ? 'meal-choice-card--expanded' : ''}" data-occurrence-key="${esc(occurrence.key)}" data-date="${esc(occurrence.date)}" data-type="${esc(occurrence.meal_type)}" data-meal-type="${esc(occurrence.meal_type)}" data-context-id="${occurrence.context?.id || ''}" data-generated-plan="${occurrence.plan?.id ? 'true' : 'false'}">
    <header class="meal-choice-card__header">
      <button type="button" class="meal-choice-card__toggle" data-action="toggle-occurrence" data-occurrence-key="${esc(occurrence.key)}" aria-expanded="${inlineExpanded}" ${detailRelation}>
        <span class="meal-choice-card__slot"><strong>${esc(occurrence.slot_label || mealTypeLabel(occurrence.meal_type))}</strong>${mealTimeLabel(occurrence) ? `<small>${esc(mealTimeLabel(occurrence))}</small>` : ''}</span>
        <span class="meal-choice-card__headline"><strong>${esc(occurrenceMealTitle(occurrence))}</strong><small>${mealText('meals.responseProgress', '{{responded}} of {{total}} responses', { responded, total })}</small></span>
      </button>
      <div class="meal-choice-card__chips">
        ${occurrence.context?.id && occurrence.context?.name ? `<span class="meal-context-chip meal-context-chip--${esc(occurrence.context.type)}"><i data-lucide="${occurrence.context.type === 'travel' ? 'plane' : 'map-pin'}" class="icon-xs" aria-hidden="true"></i>${esc(occurrence.context.name)}</span>` : occurrence.place?.name ? `<span class="meal-context-chip meal-context-chip--place"><i data-lucide="map-pin" class="icon-xs" aria-hidden="true"></i>${esc(occurrence.place.name)}</span>` : ''}
        <span class="meal-status-chip meal-status-chip--${esc(occurrence.chooser_status)}">${esc(chooserStatusLabel(occurrence.chooser_status))}</span>
      </div>
    </header>
    ${inlineExpanded ? `<div class="meal-choice-card__details" id="${domId}-details">${renderStatusOccurrenceDetails(occurrence)}</div>` : ''}
  </article>`;
}

function renderMealExperienceGrid(grid) {
  const model = activeWeekModel();
  if (state.mode === 'status' && state.statusModelError) {
    grid.classList.remove('meal-timeline');
    grid.classList.add('meal-experience-grid');
    mountLoadError(grid, {
      title: mealText('meals.statusLoadError', 'Meal Status could not be loaded.'),
      description: mealText('meals.statusLoadErrorHint', 'The choices view is still available, but household status is hidden until its exact totals can be refreshed.'),
      error: state.statusModelError,
      retryLabel: t('common.retry'),
      onRetry: async () => {
        grid.setAttribute('aria-busy', 'true');
        await loadWeekExperience();
        renderWeekExperienceHeader();
        renderWeekGrid();
      },
    });
    return;
  }
  let endpointError = null;
  if (state.mode === 'status' && state.statusModelError) endpointError = state.statusModelError;
  if (state.mode !== 'status' && state.weekModelError) endpointError = state.weekModelError;
  let occurrences = model.occurrences || [];
  if (state.selectedContextId === 'home') {
    occurrences = occurrences.filter((occurrence) => !occurrence.context?.id);
  } else if (selectedNumericContextId()) {
    occurrences = occurrences.filter((occurrence) => Number(occurrence.context?.id) === Number(state.selectedContextId));
  }
  if (state.mode === 'choices') occurrences = occurrences.filter((occurrence) => occurrence.applicable !== false);

  const selectedContext = collectMealContexts(model)
    .find((context) => Number(context.id) === Number(state.selectedContextId));
  const needsContextPlan = model.context_plan?.status === 'requires_plan_selection'
    || (selectedContext?.context_type === 'travel' || selectedContext?.type === 'travel')
      && !(selectedContext?.meal_plans || []).length;
  if (!occurrences.length && endpointError && !state.meals.length) {
    mountLoadError(grid, {
      title: mealText('meals.weekModelLoadError', 'Meal choices could not be loaded.'),
      description: t('common.loadErrorDescription'),
      error: endpointError,
      retryLabel: t('common.retry'),
      onRetry: async () => {
        grid.setAttribute('aria-busy', 'true');
        await loadWeekExperience();
        renderWeekExperienceHeader();
        renderWeekGrid();
      },
    });
    return;
  }
  if (!occurrences.length && needsContextPlan) {
    grid.classList.remove('meal-timeline');
    grid.classList.add('meal-experience-grid');
    mountEmptyState(grid, {
      icon: 'plane',
      title: mealText('meals.travelPlanRequired', 'Choose a Meal Plan for this trip'),
      description: mealText('meals.travelPlanRequiredHint', '{{context}} has no Meal Plan yet. Choose an existing plan or create a travel-specific one; the home rotation will not be used.', { context: selectedContext?.name || mealText('meals.travelContext', 'This travel context') }),
      hint: state.isAdmin
        ? mealText('meals.travelPlanAdminHint', 'Your choice applies only to this planning context.')
        : mealText('meals.travelPlanReadOnlyHint', 'An administrator can attach or create the plan.'),
      action: {
        label: state.isAdmin ? mealText('meals.chooseMealPlan', 'Choose or create Meal Plan') : mealText('meals.viewMealPlans', 'View Meal Plans'),
        icon: 'notebook-tabs',
        onClick: openMealPlanManager,
      },
    });
    grid.removeAttribute('aria-busy');
    return;
  }

  grid.classList.remove('meal-timeline');
  grid.classList.add('meal-experience-grid');
  const shouldAutoScroll = grid.dataset.experienceRenderedFor !== state.currentWeek;
  const byDate = occurrencesByDate(occurrences, state.currentWeek, addDays);
  const dayNames = DAY_NAMES();
  grid.replaceChildren();
  const board = document.createElement('div');
  board.className = 'meal-experience-board';
  board.insertAdjacentHTML('beforeend', [...byDate.entries()].slice(0, 7).map(([date, dayOccurrences]) => {
    const dayNameIndex = (zonedWeekday(date) + 6) % 7;
    const todayClass = isToday(date) ? 'meal-experience-day--today' : '';
    const headingId = `meal-day-${date}`;
    return `<section class="meal-experience-day ${todayClass}" data-date="${date}" aria-labelledby="${headingId}">
      <header class="meal-experience-day__header" id="${headingId}"><span>${dayNames[dayNameIndex]}</span><strong>${formatDayDate(date)}</strong></header>
      <div class="meal-experience-day__cards">
        ${dayOccurrences.length
          ? dayOccurrences.map((occurrence) => state.mode === 'status'
              ? renderStatusOccurrenceCard(occurrence)
              : renderChoiceOccurrenceCard(occurrence, model)).join('')
          : `<div class="meal-experience-day__empty"><span>${mealText('meals.noMealsForDay', 'No applicable meals')}</span></div>`}
      </div>
      <button class="day-add meal-experience-day__add" data-action="add-meal" data-date="${date}" data-type="${state.visibleMealTypes[0] || 'lunch'}" aria-label="${t('meals.addMealTitle')}"><i data-lucide="plus" class="icon-sm" aria-hidden="true"></i><span>${t('meals.addMealTitle')}</span></button>
    </section>`;
  }).join(''));
  grid.appendChild(board);
  grid.dataset.experienceRenderedFor = state.currentWeek;
  grid.removeAttribute('aria-busy');
  if (window.lucide) lucide.createIcons({ el: grid });
  wireGrid(grid);
  if (!grid.dataset.fadeWired) {
    grid.dataset.fadeWired = 'true';
    wireScrollFade(grid);
  }

  const deepLink = state.deepLinkOpenKey && [...grid.querySelectorAll('[data-occurrence-key]')]
    .find((element) => element.dataset.occurrenceKey === state.deepLinkOpenKey);
  if (deepLink) {
    deepLink.scrollIntoView({ block: 'nearest', inline: 'center' });
    if (usesDesktopOccurrenceDialog() && state.desktopOccurrenceDialogKey !== state.deepLinkOpenKey) {
      requestAnimationFrame(() => openOccurrenceDialog(state.deepLinkOpenKey));
    }
  }
  else if (shouldAutoScroll && window.matchMedia?.('(max-width: 640px)').matches) {
    grid.querySelector('.meal-experience-day--today')?.scrollIntoView({ block: 'start' });
  }
}

function renderWeekGrid() {
  const grid = _container.querySelector('#week-grid');
  if (!grid) return;
  grid.classList.toggle('meal-timeline', state.viewMode === 'timeline');

  _container.querySelector('#week-label').textContent =
    formatWeekLabel(state.currentWeek);

  if (state.viewMode === 'timeline' && state.mode === 'status' && state.statusModelError) {
    renderMealExperienceGrid(grid);
    return;
  }

  if (state.viewMode !== 'timeline') {
    renderMealExperienceGrid(grid);
    return;
  }

  grid.classList.remove('meal-experience-grid');

  // Fehlgeschlagene Woche: Fehlerzustand statt Leerzustand. Muss VOR der
  // Leer-Prüfung stehen - `state.meals` ist nach einem Fehler ebenfalls leer,
  // und die Reihenfolge ist das Einzige, was die beiden Fälle trennt.
  if (state.loadError) {
    grid.removeAttribute('aria-busy');
    mountLoadError(grid, {
      title: t('meals.loadError'),
      description: t('common.loadErrorDescription'),
      error: state.loadError,
      retryLabel: t('common.retry'),
      onRetry: async () => {
        grid.setAttribute('aria-busy', 'true');
        await loadWeek(state.currentWeek);
        renderWeekGrid();
      },
    });
    return;
  }

  // Leere Woche: Leerzustand statt Slot-Raster.
  //
  // Der Essensplan ist die Default-Landung des Küchen-Moduls und war bis hierher
  // der einzige der vier Tabs ohne Leerzustand - ein neuer Haushalt sah bis zu
  // 28 gestrichelte Kästen ohne ein Wort, während die drei Geschwister je einen
  // vollständigen Leerzustand mit CTA hatten (Critique P0, 2026-07-29).
  //
  // Der Hinweis richtet sich danach, was der Haushalt schon hat: ohne Rezepte
  // nennt er die nächste Station des Kreislaufs (der Plan füllt die
  // Einkaufsliste), mit Rezepten den schnelleren Weg (Rezept direkt einplanen).
  // Die Wochennavigation im Kopf bleibt erreichbar - der Leerzustand ersetzt nur
  // das Raster, nicht die Seite.
  if (!state.meals.length) {
    grid.removeAttribute('aria-busy');
    mountEmptyState(grid, {
      icon: 'utensils',
      title: t('meals.emptyTitle'),
      description: t('meals.emptyDescription'),
      hint: state.recipes.length ? t('meals.emptyHintRecipes') : t('emptyHint.meals'),
      action: {
        label: t('meals.emptyAction'),
        icon: 'plus',
        onClick: () => openMealForSelectedContext({
          mode: 'create',
          date: state.currentWeek,
          mealType: state.visibleMealTypes[0] ?? 'lunch',
        }),
      },
    });
    return;
  }

  if (state.viewMode === 'timeline') {
    renderTimelineGrid(grid);
    return;
  }

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(state.currentWeek, i));
  const dayNames = DAY_NAMES();
  // Default-Typ für den mobilen Per-Tag-Add-Button (Modal lässt den Typ ändern).
  const firstType = state.visibleMealTypes[0] ?? 'lunch';
  const visibleTypes = MEAL_TYPES().filter((type) => state.visibleMealTypes.includes(type.key));

  // Desktop-Board: Typ-Label EINMAL pro Zeile in der linken Gutter-Spalte statt
  // in jedem der bis zu 28 Slots (Critique P1: 21 redundante, silbengetrennte
  // Labels pro Woche). Mobil unsichtbar (display:none); die Slot-eigenen Labels
  // bleiben dort sichtbar und am Desktop als Screenreader-Text erhalten —
  // darum ist die Gutter-Spalte fürs Accessibility-Tree ein reines Duplikat
  // und wird mit aria-hidden ausgeblendet.
  const gutterHTML = visibleTypes.map((type, ti) => `
    <div class="week-gutter-label" data-type="${type.key}" style="--type-row: ${ti + 2}" aria-hidden="true">
      <span class="week-gutter-label__text">${type.label}</span>
    </div>
  `).join('');

  grid.replaceChildren();
  grid.insertAdjacentHTML('beforeend', gutterHTML + weekDays.map((date, dayIndex) => {
    const mealsForDay = state.meals.filter((m) => m.date === date);
    const todayClass  = isToday(date) ? 'day-header--today' : '';
    // zonedWeekday statt `new Date(key + 'T00:00:00').getDay()`: derselbe Wert,
    // aber ohne den Umweg ueber ein Date der Browser-Zone (#829 Teil 3).
    const dayNameIndex = (zonedWeekday(date) + 6) % 7;
    // Spalte 1 ist die Gutter-Spalte, Zeile 1 die Kopfzeile — Inhalte ab 2.
    const dayCol = dayIndex + 2;

    return `
      <div class="day-column">
        <div class="day-header ${todayClass}" style="--day-col: ${dayCol}">
          <span class="day-header__name">${dayNames[dayNameIndex]}</span>
          <span class="day-header__date">${formatDayDate(date)}</span>
        </div>
        <div class="day-slots">
          ${visibleTypes.map((type, ti) => renderSlot(date, type, mealsForDay, dayCol, ti + 2)).join('')}
        </div>
        <button class="day-add" data-action="add-meal" data-date="${date}" data-type="${firstType}" aria-label="${t('meals.addMealTitle')}">
          <i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>
          <span>${t('meals.addMealTitle')}</span>
        </button>
      </div>
    `;
  }).join(''));

  grid.removeAttribute('aria-busy');
  if (window.lucide) lucide.createIcons({ el: grid });
  stagger(grid.querySelectorAll('.meal-card'));
  wireGrid(grid);

  // Scroll-Affordance des Desktop-Boards: End-Anriss signalisiert verborgene
  // Tage rechts (Critique-Folgebefund; Muster wie Tab-Leisten/Chip-Zeilen).
  // Einmal binden — der MutationObserver von wireScrollFade deckt spätere
  // replaceChildren-Rerenders ab.
  if (!grid.dataset.fadeWired) {
    grid.dataset.fadeWired = 'true';
    wireScrollFade(grid);
  }

  // Auf schmalen Viewports (gestapelte Tage) den heutigen Tag in den Blick scrollen.
  if (window.matchMedia?.('(max-width: 640px)').matches) {
    grid.querySelector('.day-header--today')?.closest('.day-column')
      ?.scrollIntoView({ block: 'start' });
  } else if (grid.scrollWidth > grid.clientWidth + 1) {
    // Desktop-Board mit horizontalem Scroll-Fenster: heutigen Tag in den Blick
    // holen - aber NUR, wenn er nicht ohnehin sichtbar ist.
    //
    // Vorher zentrierte diese Zeile unbedingt und erzeugte damit `scrollLeft`
    // von 156px, obwohl heute (Mittwoch) längst im Fenster lag. Der erste
    // Wochentag rutschte dadurch hinter die sticky Gutter-Spalte, deren
    // opaker Hintergrund ihn vollständig verdeckte: Montag war bei jedem Laden
    // reproduzierbar unsichtbar, ohne jeden Hinweis (Critique 2026-07-30).
    // Die Woche beginnt jetzt bei Montag, solange heute im Blick ist.
    const todayHeader = grid.querySelector('.day-header--today');
    if (todayHeader) {
      const gridBox = grid.getBoundingClientRect();
      const todayBox = todayHeader.getBoundingClientRect();
      const gutter = grid.querySelector('.week-gutter-label')?.getBoundingClientRect().width ?? 0;
      const verdeckt = todayBox.left < gridBox.left + gutter || todayBox.right > gridBox.right;
      if (verdeckt) todayHeader.scrollIntoView({ inline: 'center', block: 'nearest' });
    }
  }
}

function renderTimelineGrid(grid) {
  const weekDays = Array.from({ length: 7 }, (_, index) => addDays(state.currentWeek, index));
  const dayNames = DAY_NAMES();
  const typeLabels = Object.fromEntries(MEAL_TYPES().map((type) => [type.key, type.label]));
  const model = activeWeekModel();
  let occurrences = model.occurrences || [];
  if (state.selectedContextId === 'home') {
    occurrences = occurrences.filter((occurrence) => !occurrence.context?.id);
  } else if (selectedNumericContextId()) {
    occurrences = occurrences.filter((occurrence) => Number(occurrence.context?.id) === selectedNumericContextId());
  }
  if (state.mode === 'choices') occurrences = occurrences.filter((occurrence) => occurrence.applicable !== false);
  grid.classList.add('meal-timeline');
  grid.replaceChildren();
  grid.insertAdjacentHTML('beforeend', weekDays.map((date) => {
    const dayMeals = occurrences.filter((meal) => meal.date === date).sort((a, b) =>
      String(a.scheduled_time || a.preferred_time || '99:99').localeCompare(String(b.scheduled_time || b.preferred_time || '99:99'))
    );
    const dayNameIndex = (zonedWeekday(date) + 6) % 7;
    return `<section class="meal-timeline__day ${isToday(date) ? 'meal-timeline__day--today' : ''}">
      <header class="meal-timeline__header"><strong>${dayNames[dayNameIndex]}</strong><span>${formatDayDate(date)}</span></header>
      <div class="meal-timeline__items">${dayMeals.map((meal) => {
        const time = meal.scheduled_time || meal.preferred_time || mealText('meals.anyTime', 'Any time');
        const decision = state.mode === 'choices' ? decisionForMember(meal, state.selectedMemberId) : null;
        const title = state.mode === 'choices'
          ? decisionFoodSummary(meal, decision).title
          : mealDisplayTitle(meal, mealText('meals.pending', 'Pending'));
        const mealId = Number(meal.meal?.id || meal.id);
        const canEdit = state.mode === 'choices' && mealId > 0;
        const roles = (meal.participants || []).map((participant) => `${participant.display_name} · ${participant.role}`).join(', ');
        return `<button type="button" class="meal-timeline__item" data-action="edit-meal" data-meal-id="${mealId}" ${canEdit ? '' : 'disabled aria-disabled="true"'}>
          <span class="meal-timeline__time">${esc(time)}</span>
          <span class="meal-timeline__copy"><strong>${esc(title)}</strong><small>${esc(typeLabels[meal.meal_type] || meal.meal_type)}${roles ? ` · ${esc(roles)}` : ''}</small></span>
          <i data-lucide="chevron-right" class="icon-sm" aria-hidden="true"></i>
        </button>`;
      }).join('') || `<button type="button" class="meal-timeline__empty" data-action="add-meal" data-date="${date}" data-type="${state.visibleMealTypes[0] || 'lunch'}"><i data-lucide="plus" class="icon-sm"></i>${mealText('meals.addMeal', 'Add a meal')}</button>`}</div>
    </section>`;
  }).join(''));
  grid.removeAttribute('aria-busy');
  if (window.lucide) lucide.createIcons({ el: grid });
  wireGrid(grid);
}

function renderRecipeSidebar() {
  const sidebar = _container.querySelector('#recipe-sidebar');
  if (!sidebar) return;
  sidebar.replaceChildren();

  const title = document.createElement('h2');
  title.className = 'recipe-sidebar__title';
  title.textContent = t('nav.recipes');
  sidebar.appendChild(title);

  // Der Drag-Hinweis erscheint nur, wenn es etwas zu ziehen gibt. Vorher stand
  // „Ziehe Rezepte auf Essens-Slots" unbedingt da - bei leerem Haushalt direkt
  // über „Noch keine Rezepte", also eine Anleitung für etwas, das es nicht gibt.
  // Das war der einzige Text auf dem ersten Screen des Moduls und widersprach
  // sich selbst (Critique P0, 2026-07-29).
  if (!state.recipes.length) {
    // Geteilter Renderer statt nacktem Satz: das Panel war die fünfte Leerfläche
    // im Modul und die einzige, die den Renderer umging - ohne Icon, ohne CTA,
    // direkt neben dem gestalteten Leerzustand des Boards (Critique 2026-07-30).
    sidebar.appendChild(emptyStateEl({
      icon: 'book-text',
      title: t('recipes.emptyTitle'),
      description: t('recipes.emptyDescription'),
      action: {
        label: t('recipes.emptyAction'),
        icon: 'plus',
        onClick: () => window.yuvomi?.navigate('/recipes'),
      },
    }));
    if (window.lucide) window.lucide.createIcons({ el: sidebar });
    return;
  }

  const hint = document.createElement('p');
  hint.className = 'recipe-sidebar__hint';
  hint.textContent = t('recipes.dragToMealsHint');
  sidebar.appendChild(hint);

  const list = document.createElement('div');
  list.className = 'recipe-sidebar__list';

  state.recipes.forEach((recipe) => {
    const card = document.createElement('article');
    card.className = 'recipe-sidebar__card';
    card.draggable = true;
    card.dataset.recipeId = String(recipe.id);

    const titleEl = document.createElement('div');
    titleEl.className = 'recipe-sidebar__card-title';
    titleEl.textContent = recipe.title;
    card.appendChild(titleEl);

    if (recipe.source !== 'native') {
      const sourceBadgeEl = document.createElement('span');
      sourceBadgeEl.className = `source-badge source-badge--${recipe.source}`;
      sourceBadgeEl.textContent = t(`recipes.source${recipe.source[0].toUpperCase()}${recipe.source.slice(1)}`);
      if (recipe.provider_account_name) sourceBadgeEl.title = recipe.provider_account_name;
      card.appendChild(sourceBadgeEl);
    }

    // Mahlzeiten-Chips nur bei echter Teilmenge: ein Rezept, das zu allen Typen
    // passt, trägt mit "überall"-Chips null Information und ist dann das
    // lauteste Element der Karte (Audit P2, Muster wie recipes.js showBadges).
    // Der leere Fall ist seit #750 die Gegenprobe und keine Teilmenge mehr: Er
    // sagt „nur von Hand", denn der Zufallsvorschlag übergeht dieses Rezept.
    const recipeTypes = normalizeRecipeMealTypes(recipe.meal_types);
    const allTypeOptions = recipeMealTypeOptions();
    if (recipeTypes.length && recipeTypes.length < allTypeOptions.length) {
      const types = document.createElement('div');
      types.className = 'recipe-sidebar__card-types';
      allTypeOptions
        .filter((option) => recipeTypes.includes(option.key))
        .forEach((option) => {
          const badge = document.createElement('span');
          badge.className = `meal-type-badge meal-type-badge--${option.key}`;
          badge.textContent = option.label;
          types.appendChild(badge);
        });
      card.appendChild(types);
    } else if (!recipeTypes.length) {
      const types = document.createElement('div');
      types.className = 'recipe-sidebar__card-types';
      const badge = document.createElement('span');
      badge.className = 'meal-type-badge meal-type-badge--none';
      badge.textContent = t('recipes.mealTypeNone');
      types.appendChild(badge);
      card.appendChild(types);
    }

    list.appendChild(card);
  });

  sidebar.appendChild(list);
}

function renderSlot(date, type, mealsForDay, dayCol, typeRow) {
  const meals = mealsForDay.filter((m) => m.meal_type === type.key);
  // Explizite Grid-Platzierung fürs Desktop-Board (day-column/day-slots werden
  // dort zu display:contents); mobil ohne Wirkung, da die Slots im Fluss liegen.
  const gridPos = `--day-col: ${dayCol}; --type-row: ${typeRow}`;

  if (!meals.length) {
    return `
      <div class="meal-slot meal-slot--empty" data-date="${date}" data-type="${type.key}" style="${gridPos}">
        <div class="meal-slot__type-label"><span class="meal-slot__type-text">${type.label}</span></div>
        <button
          class="meal-slot__add-btn"
          data-action="add-meal"
          data-date="${date}"
          data-type="${type.key}"
          aria-label="${t('meals.addMeal', { type: type.label })}"
        >
          <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
        </button>
      </div>
    `;
  }

  // Die Aktions-Labels NENNEN ihre Mahlzeit („Fluffige Pancakes loeschen"):
  // vorher trugen alle Karten dieselben drei Saetze, und ein Screenreader, der
  // die Woche durchgeht, hoerte 25x „Mahlzeit loeschen" ohne Bezug (Critique
  // 2026-08-27, Persona Sam). Dasselbe Muster wie im Einkauf („Brokkoli
  // abhaken", shopping.markDoneLabel).
  const cardsHTML = meals.map((meal) => {
    const ownCount    = meal.ingredients?.length ?? 0;
    const ingDone     = meal.ingredients?.filter((i) => i.on_shopping_list).length ?? 0;
    // Aus einem Rezept geplante Mahlzeiten haben noch keine eigenen Zutaten;
    // der Server liefert dafür die Zahl aus dem Rezept mit. Sonst bliebe der
    // Einkaufslisten-Button genau dort aus, wo die Zutaten längst bekannt sind
    // (Critique 2026-07-29: sichtbar auf 1 von 22 Karten). Der erste Transfer
    // materialisiert sie, danach zählt wieder ownCount.
    const recipeCount = ownCount === 0 ? (meal.recipe_ingredient_count ?? 0) : 0;
    const ingCount    = ownCount || recipeCount;
    const ingLabel    = ingCount > 0 ? t('meals.ingredientCount', { count: ingCount }) : '';
    const ingDoneLabel = ownCount > 0 && ingDone === ownCount ? ' ✓' : '';
    const canTransfer  = recipeCount > 0 || (ownCount > 0 && ingDone < ownCount);
    const recurrenceBadge = meal.recurrence_template_id
      ? `<span class="meal-card__recurrence" aria-label="${t('meals.recurrenceBadge')}"><i data-lucide="repeat-2" class="icon-sm" aria-hidden="true"></i></span>`
      : '';
    const mealTime = meal.scheduled_time || meal.preferred_time || '';
    const roleSummary = (meal.participants || [])
      .filter((participant) => participant.role === 'chooser' || participant.role === 'cook')
      .map((participant) => `${participant.display_name} · ${participant.role}`)
      .join(', ');
    const mealPlace = (state.planning.places || []).find((place) => Number(place.id) === Number(meal.place_id));
    const activeConflicts = (meal.calendar_conflicts || []).filter((conflict) => conflict.active);
    const executionProgress = meal.execution
      ? t('meals.executionProgress', { done: Number(meal.execution.task_done || 0), total: Number(meal.execution.task_total || 0) })
      : '';

    // Die Karte ist bewusst KEIN Button: sie trägt Buttons und einen Link, und
    // interaktiver Inhalt in einem Button ist invalides HTML - Screenreader
    // verlieren dann die inneren Aktionen (Critique 2026-08-17). Das Öffnen
    // gehört der Titelfläche; die Aktionen stehen daneben, nicht darin.
    return `
      <div class="meal-card" data-meal-id="${meal.id}">
        <button type="button" class="meal-card__open"
           data-action="edit-meal"
           data-meal-id="${meal.id}">
          <span class="meal-card__title"><span class="meal-card__title-text">${esc(meal.title)}</span>${recurrenceBadge}</span>
          ${mealTime || roleSummary || mealPlace || activeConflicts.length || executionProgress ? `<span class="meal-card__planning">${mealTime ? `<span>${esc(mealTime)}</span>` : ''}${mealPlace ? `<span>${esc(mealPlace.name)}</span>` : ''}${roleSummary ? `<span>${esc(roleSummary)}</span>` : ''}${activeConflicts.length ? `<span>${activeConflicts.length} Calendar conflict${activeConflicts.length === 1 ? '' : 's'}</span>` : ''}${executionProgress ? `<span>${esc(executionProgress)}</span>` : ''}</span>` : ''}
          ${ingLabel ? `<span class="meal-card__meta">
            <span class="meal-card__ingredients-count">${ingLabel}${esc(ingDoneLabel)}</span>
          </span>` : ''}
        </button>
        <div class="meal-card__actions">
          ${meal.selection_status === 'selected' ? `<button class="meal-card__action-btn" data-action="meal-execution" data-meal-id="${meal.id}" aria-label="${esc(t('meals.executionButtonNamed', { title: meal.title }))}"><i data-lucide="list-checks" class="icon-sm" aria-hidden="true"></i></button>` : ''}
          ${activeConflicts.length ? `<button class="meal-card__action-btn" data-action="resolve-conflicts" data-meal-id="${meal.id}" aria-label="Review Calendar conflicts for ${esc(meal.title)}"><i data-lucide="triangle-alert" class="icon-sm" aria-hidden="true"></i></button>` : ''}
          ${meal.recipe_url ? `<a class="meal-card__action-btn meal-card__action-btn--recipe"
            data-action="open-recipe"
            href="${esc(meal.recipe_url)}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="${esc(t('meals.openRecipeNamed', { title: meal.title }))}"
          ><i data-lucide="link" class="icon-sm" aria-hidden="true"></i></a>` : ''}
          ${canTransfer ? `<button class="meal-card__action-btn meal-card__action-btn--shopping"
            data-action="transfer-meal"
            data-meal-id="${meal.id}"
            aria-label="${esc(t('common.toShoppingListNamed', { title: meal.title }))}"
          ><i data-lucide="shopping-cart" class="icon-sm" aria-hidden="true"></i></button>` : ''}
          <button class="meal-card__action-btn"
            data-action="delete-meal"
            data-meal-id="${meal.id}"
            aria-label="${esc(t('meals.deleteMealNamed', { title: meal.title }))}"
          ><i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i></button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="meal-slot meal-slot--has-meal" data-date="${date}" data-type="${type.key}" style="${gridPos}">
      <div class="meal-slot__type-label"><span class="meal-slot__type-text">${type.label}</span></div>
      ${cardsHTML}
      <button
        class="meal-slot__add-more-btn"
        data-action="add-meal"
        data-date="${date}"
        data-type="${type.key}"
        aria-label="${t('meals.addMeal', { type: type.label })}"
      ><i data-lucide="plus" class="icon-sm" aria-hidden="true"></i></button>
    </div>
  `;
}

// --------------------------------------------------------
// Event-Delegation
// --------------------------------------------------------

function openConflictModal(meal) {
  const conflicts = (meal.calendar_conflicts || []).filter((conflict) => conflict.active);
  const members = state.planning.members || [];
  const content = `<div class="meal-conflicts"><p class="form-hint">These overlaps are advisory. Resolve each affected person independently; changing a Calendar title or description will not reopen a resolved conflict.</p>${conflicts.map((conflict) => `<form class="meal-conflict" data-conflict-id="${conflict.id}"><strong>${esc(conflict.user_name)} • ${esc(conflict.calendar_title || 'Calendar event')}</strong><p class="form-hint">${esc(conflict.occurrence_start)} → ${esc(conflict.occurrence_end || '')}</p><select class="form-input" name="resolution"><option value="participating">Still participating</option><option value="not_participating">Not participating</option><option value="time_changed">Move meal within its window</option><option value="backup_assigned">Assign a backup participant</option><option value="personal_alternative">Create a personal alternative</option><option value="keep_preferred_time">Keep preferred time</option><option value="keep_window">Keep acceptable window</option><option value="ignore">Ignore this conflict</option></select><div data-conflict-extra style="margin-top:var(--space-2)"></div><button class="btn btn--primary btn--sm" type="submit">Save resolution</button></form>`).join('')}</div>`;
  openSharedModal({ title: `Calendar conflicts • ${meal.title}`, content, size: 'lg', onSave(panel) {
    panel.querySelectorAll('[data-conflict-id]').forEach((form) => {
      const select = form.querySelector('[name="resolution"]'); const extra = form.querySelector('[data-conflict-extra]');
      const renderExtra = () => {
        extra.replaceChildren();
        if (select.value === 'time_changed') extra.insertAdjacentHTML('beforeend', `<label class="label">New meal time<input class="form-input" name="scheduled_time" type="time" required></label>`);
        else if (select.value === 'backup_assigned') extra.insertAdjacentHTML('beforeend', `<label class="label">Backup person<select class="form-input" name="user_id">${members.map((member) => `<option value="${member.id}">${esc(member.display_name)}</option>`).join('')}</select></label>`);
        else if (select.value === 'personal_alternative') extra.insertAdjacentHTML('beforeend', `<label class="label">Alternative meal<input class="form-input" name="title" required placeholder="Personal meal"></label><label class="label">Notes<textarea class="form-input" name="notes" rows="2"></textarea></label>`);
      };
      select.addEventListener('change', renderExtra); renderExtra();
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); const data = new FormData(form); const submit = form.querySelector('button[type="submit"]'); submit.disabled = true;
        const payload = {};
        if (data.get('scheduled_time')) payload.scheduled_time = data.get('scheduled_time');
        if (data.get('user_id')) payload.user_id = Number(data.get('user_id'));
        if (data.get('title')) payload.title = data.get('title');
        if (data.get('notes')) payload.notes = data.get('notes');
        try {
          await api.post(`/meals/conflicts/${form.dataset.conflictId}/resolve`, { resolution: data.get('resolution'), payload });
          form.replaceChildren();
          const confirmation = document.createElement('p');
          confirmation.className = 'form-hint';
          confirmation.textContent = 'Resolved.';
          form.appendChild(confirmation);
          await loadWeek(state.currentWeek); renderWeekGrid();
        } catch (error) { window.yuvomi?.showToast(error.message, 'danger'); submit.disabled = false; }
      });
    });
  }});
}

function setWeekBusy() {
  // Sichtbares Lade-Feedback beim Wochenwechsel (dimmt das Raster via CSS,
  // meldet Screenreadern „busy"), bis renderWeekGrid das Attribut wieder entfernt.
  _container.querySelector('#week-grid')?.setAttribute('aria-busy', 'true');
}

function executionSummaryCounts(execution) {
  const meals = Array.isArray(execution?.meals) ? execution.meals : [];
  const tasks = meals.flatMap((meal) => meal?.tasks || []);
  return {
    meals: meals.length,
    tasks: tasks.filter((task) => task.task_id).length,
    groceryItems: Number(execution?.grocery_run?.items?.length || execution?.grocery_run?.item_count || 0),
  };
}

function openExecutionSummary(execution) {
  const counts = executionSummaryCounts(execution);
  const grocery = execution?.grocery_run;
  const content = `<div class="meal-execution-summary">
    <p class="form-hint">${esc(t('meals.executionSummaryDescription'))}</p>
    <div class="meal-execution-summary__stats">
      <div><strong>${counts.meals}</strong><span>${esc(t('meals.executionMeals'))}</span></div>
      <div><strong>${counts.tasks}</strong><span>${esc(t('meals.executionTasks'))}</span></div>
      <div><strong>${counts.groceryItems}</strong><span>${esc(t('meals.executionGroceries'))}</span></div>
    </div>
    ${grocery ? `<p class="meal-execution-summary__status"><i data-lucide="shopping-cart" class="icon-sm" aria-hidden="true"></i>${esc(t('meals.groceryRunStatus', { status: grocery.status }))}</p>` : `<p class="form-hint">${esc(t('meals.noGroceryListConfigured'))}</p>`}
    <div class="modal-panel__footer modal-panel__footer--plain">
      <button type="button" class="btn btn--secondary" data-open-tasks>${esc(t('meals.openTasks'))}</button>
      ${grocery ? `<button type="button" class="btn btn--primary" data-open-shopping>${esc(t('meals.openShopping'))}</button>` : ''}
    </div>
  </div>`;
  openSharedModal({ title: t('meals.executionSummaryTitle'), content, size: 'md', onSave(panel) {
    panel.querySelector('[data-open-tasks]')?.addEventListener('click', () => {
      closeSharedModal({ force: true });
      window.yuvomi?.navigate('/tasks');
    });
    panel.querySelector('[data-open-shopping]')?.addEventListener('click', () => {
      closeSharedModal({ force: true });
      window.yuvomi?.navigate('/shopping');
    });
    if (window.lucide) window.lucide.createIcons({ el: panel });
  }});
}

function openMealExecutionDetail(execution) {
  const roleLabels = {
    preparation: t('meals.rolePreparation'), cooking: t('meals.roleCooking'),
    supervision: t('meals.roleSupervision'), serving: t('meals.roleServing'), cleanup: t('meals.roleCleanup'),
  };
  const tasks = execution?.tasks || [];
  const content = `<div class="meal-execution-detail">
    <p class="form-hint">${esc(t('meals.executionRevision', { revision: execution?.revision || 1, status: execution?.status || 'planned' }))}</p>
    <div class="meal-execution-detail__tasks">${tasks.map((task) => `<button type="button" class="meal-execution-task" data-task-id="${task.task_id || ''}" ${task.task_id ? '' : 'disabled'}>
      <i data-lucide="${task.task_status === 'done' ? 'circle-check-big' : 'circle'}" class="icon-sm" aria-hidden="true"></i>
      <span><strong>${esc(roleLabels[task.role] || task.role)}</strong><small>${esc(task.title_snapshot)} · ${esc(task.due_date_snapshot)} ${esc(task.due_time_snapshot || '')}${task.assigned_name ? ` · ${esc(task.assigned_name)}` : ''}</small></span>
    </button>`).join('') || `<p class="form-hint">${esc(t('meals.noExecutionTasks'))}</p>`}</div>
    <div class="modal-panel__footer modal-panel__footer--plain"><button type="button" class="btn btn--secondary" data-open-pantry>${esc(t('meals.openPantry'))}</button><button type="button" class="btn btn--primary" data-open-tasks>${esc(t('meals.openTasks'))}</button></div>
  </div>`;
  openSharedModal({ title: execution?.meal_title_snapshot || t('meals.executionSummaryTitle'), content, size: 'md', onSave(panel) {
    panel.querySelectorAll('[data-task-id]').forEach((button) => button.addEventListener('click', () => {
      closeSharedModal({ force: true });
      window.yuvomi?.navigate(`/tasks?open=${button.dataset.taskId}`);
    }));
    panel.querySelector('[data-open-tasks]')?.addEventListener('click', () => {
      closeSharedModal({ force: true });
      window.yuvomi?.navigate('/tasks');
    });
    panel.querySelector('[data-open-pantry]')?.addEventListener('click', () => {
      closeSharedModal({ force: true });
      window.yuvomi?.navigate('/pantry');
    });
    if (window.lucide) window.lucide.createIcons({ el: panel });
  }});
}

async function prepareCurrentWeek(button) {
  if (button) button.disabled = true;
  try {
    const response = await api.post('/meals/planning/materialize', { week: state.currentWeek });
    await Promise.all([loadWeek(state.currentWeek), loadPlanning(), loadWeekExperience()]);
    renderWeekExperienceHeader();
    renderWeekGrid();
    if (response.data?.execution) openExecutionSummary(response.data.execution);
    else window.yuvomi?.showToast(t('meals.automationDisabledToast'), 'warning');
  } catch (error) {
    window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
  } finally {
    if (button) button.disabled = false;
  }
}

function renderMealMenuEditorRow(item = {}, occurrence = null) {
  const kind = item.item_type || item.kind || 'side';
  const selectedIds = new Set((occurrence?.decisions || []).flatMap((decision) => [
    ...(decision.selected_menu_item_ids || []),
    ...(decision.menu_items || []).map((selected) => selected?.id ?? selected?.menu_item_id),
  ]).map(Number).filter(Number.isFinite));
  const locked = item.id && selectedIds.has(Number(item.id));
  return `<div class="meal-menu-editor__row ${locked ? 'meal-menu-editor__row--locked' : ''}" data-menu-editor-row data-menu-item-id="${item.id || ''}" data-original-kind="${esc(kind)}" data-original-position="${Number(item.position ?? 0)}">
    <label class="label">${mealText('meals.menuItemType', 'Type')}<select class="form-input" name="menu_item_type" ${locked ? 'disabled' : ''}><option value="entree" ${kind === 'entree' ? 'selected' : ''}>${mealText('meals.entree', 'Entrée')}</option><option value="side" ${kind === 'side' ? 'selected' : ''}>${mealText('meals.side', 'Side')}</option></select></label>
    <label class="label meal-menu-editor__title">${mealText('meals.menuItemName', 'Meal or recipe')}<input class="form-input" name="menu_item_title" list="meal-menu-recipe-list" maxlength="300" required value="${esc(item.title || item.label || '')}" placeholder="${mealText('meals.recipeOrCustomPlaceholder', 'Choose a recipe or type a new meal')}" ${locked ? 'disabled' : ''}><input type="hidden" name="menu_item_recipe" value="${Number(item.recipe_id) || ''}"><small class="form-hint">${mealText('meals.recipeOrCustomHint', 'Matches use saved recipes; new text is saved as a custom dish and can be linked when the meal is edited later.')}</small></label>
    ${locked ? `<span class="meal-menu-editor__locked"><i data-lucide="lock" class="icon-sm" aria-hidden="true"></i>${mealText('meals.menuItemInUse', 'Already selected; kept in meal history')}</span>` : `<button type="button" class="btn btn--ghost btn--sm meal-menu-editor__remove" data-menu-editor-remove aria-label="${mealText('meals.removeMenuItem', 'Remove menu item')}"><i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i></button>`}
  </div>`;
}

async function openMealMenuEditor(occurrence) {
  const mealId = Number(occurrence.meal?.id || occurrence.id);
  if (!mealId) return;
  let items;
  try {
    const response = await api.get(`/meals/${mealId}/menu-items`);
    items = response?.data ?? response ?? [];
  } catch (error) {
    window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
    return;
  }
  // Released shared-menu Backup rows are audit-only. The backend preserves
  // them automatically; modern edits submit only the current entree/sides.
  items = items.filter((item) => (item.item_type || item.kind) !== 'backup');
  const courseLimits = mealCourseLimits(occurrence);
  if (!items.length && courseLimits.max_entree_choices > 0) {
    items = [{ item_type: 'entree', position: 0, title: '' }];
  } else if (!items.length && courseLimits.max_side_choices > 0) {
    items = [{ item_type: 'side', position: 0, title: '' }];
  }
  const limitSummary = `${mealText('meals.maxEntrees', 'Maximum entrées')}: ${courseLimits.max_entree_choices}. ${mealText('meals.maxSides', 'Maximum sides')}: ${courseLimits.max_side_choices}.`;
  const content = `<form id="meal-menu-editor-form" class="meal-menu-editor">
    <p class="form-hint">${esc(limitSummary)}</p>
    <div class="meal-menu-editor__items" data-menu-editor-items>${items.map((item) => renderMealMenuEditorRow(item, occurrence)).join('')}</div>
    <datalist id="meal-menu-recipe-list">${state.recipes.map((recipe) => `<option value="${esc(recipe.title)}"></option>`).join('')}</datalist>
    <div class="meal-menu-editor__add-actions"><button type="button" class="btn btn--secondary" data-menu-editor-add="entree"><i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>${mealText('meals.entree', 'Entrée')}</button><button type="button" class="btn btn--secondary" data-menu-editor-add="side"><i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>${mealText('meals.side', 'Side')}</button></div>
    <div class="modal-panel__footer modal-panel__footer--plain"><button type="button" class="btn btn--secondary" data-action="close-modal">${t('common.cancel')}</button><button type="submit" class="btn btn--primary">${t('common.save')}</button></div>
  </form>`;
  openSharedModal({ title: mealText('meals.menuEditorTitle', 'Meal options'), content, size: 'lg', onSave(panel) {
    const list = panel.querySelector('[data-menu-editor-items]');
    const currentLimitState = () => mealMenuOptionLimitState(
      [...list.querySelectorAll('[data-menu-editor-row]')].map((row) => ({
        item_type: row.querySelector('[name="menu_item_type"]')?.value,
      })),
      occurrence,
    );
    const syncLimitControls = () => {
      const limitState = currentLimitState();
      const entreeButton = panel.querySelector('[data-menu-editor-add="entree"]');
      const sideButton = panel.querySelector('[data-menu-editor-add="side"]');
      if (entreeButton) entreeButton.disabled = !limitState.can_add_entree;
      if (sideButton) sideButton.disabled = !limitState.can_add_side;
    };
    const wireRow = (row) => {
      row.querySelector('[data-menu-editor-remove]')?.addEventListener('click', () => {
        row.remove();
        syncLimitControls();
      });
      row.querySelector('[name="menu_item_type"]')?.addEventListener('change', syncLimitControls);
      const title = row.querySelector('[name="menu_item_title"]');
      const recipeId = row.querySelector('[name="menu_item_recipe"]');
      title?.addEventListener('input', () => {
        const recipe = state.recipes.find((entry) => entry.title.localeCompare(title.value.trim(), undefined, { sensitivity: 'base' }) === 0);
        recipeId.value = recipe ? String(recipe.id) : '';
      });
    };
    list.querySelectorAll('[data-menu-editor-row]').forEach(wireRow);
    panel.querySelectorAll('[data-menu-editor-add]').forEach((button) => button.addEventListener('click', () => {
      const kind = button.dataset.menuEditorAdd;
      const limitState = currentLimitState();
      if ((kind === 'entree' && !limitState.can_add_entree)
          || (kind === 'side' && !limitState.can_add_side)) return;
      list.insertAdjacentHTML('beforeend', renderMealMenuEditorRow({ item_type: kind, position: 0 }, occurrence));
      const row = list.lastElementChild;
      wireRow(row);
      syncLimitControls();
      if (window.lucide) lucide.createIcons({ el: row });
      row.querySelector('[name="menu_item_title"]')?.focus();
    }));
    syncLimitControls();
    panel.querySelector('#meal-menu-editor-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const rows = [...list.querySelectorAll('[data-menu-editor-row]')];
      const values = rows.map((row) => ({
        row,
        id: Number(row.dataset.menuItemId) || null,
        originalKind: row.dataset.originalKind,
        originalPosition: Number(row.dataset.originalPosition),
        item_type: row.querySelector('[name="menu_item_type"]').value,
        title: row.querySelector('[name="menu_item_title"]').value.trim(),
        recipe_id: Number(row.querySelector('[name="menu_item_recipe"]').value) || null,
      }));
      if (values.some((value) => !value.title)) {
        const invalid = values.find((value) => !value.title)?.row.querySelector('[name="menu_item_title"]');
        invalid?.focus();
        window.yuvomi?.showToast(mealText('meals.menuItemNameRequired', 'Name every meal option.'), 'warning');
        return;
      }
      const limitState = mealMenuOptionLimitState(values, occurrence);
      if (!limitState.valid) {
        window.yuvomi?.showToast(limitSummary, 'warning');
        return;
      }
      const submit = panel.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const reservedPositions = new Map(['entree', 'side'].map((type) => [type, new Set()]));
        values.forEach((value) => {
          if (value.id && value.item_type === value.originalKind) {
            reservedPositions.get(value.item_type).add(value.originalPosition);
          }
        });
        const desiredItems = values.map((value) => {
          let position = value.originalPosition;
          if (!value.id || value.item_type !== value.originalKind) {
            position = 0;
            const reserved = reservedPositions.get(value.item_type);
            while (reserved.has(position)) position += 1;
            reserved.add(position);
          }
          return {
            ...(value.id ? { id: value.id } : {}),
            item_type: value.item_type,
            title: value.title,
            recipe_id: value.recipe_id,
            position,
          };
        });
        await api.put(`/meals/${mealId}/menu-items`, {
          items: desiredItems,
          beneficiary_user_id: Number(state.selectedMemberId),
          device_key: stableMealDeviceKey(),
        });
        await loadWeekExperience();
        closeSharedModal({ force: true });
        renderWeekExperienceHeader();
        renderWeekGrid();
        window.yuvomi?.showToast(mealText('meals.menuSaved', 'Meal options saved.'), 'success');
      } catch (error) {
        window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
        submit.disabled = false;
      }
    });
    if (window.lucide) lucide.createIcons({ el: panel });
  }});
}

async function loadMealPlans() {
  const response = await api.get('/meals/plans');
  const data = response?.data ?? response;
  state.mealPlans = Array.isArray(data) ? data : (data?.plans || []);
  return state.mealPlans;
}

function planMemberOptions(selected, emptyLabel = null) {
  const members = state.weekModel?.members?.length ? state.weekModel.members : (state.planning.members || []);
  return `<option value="">${esc(emptyLabel || mealText('meals.chooseMember', 'Choose a member'))}</option>${members.map((member) => `
    <option value="${member.id}" ${Number(selected) === Number(member.id) ? 'selected' : ''}>${esc(member.display_name || member.name)}</option>
  `).join('')}`;
}

function planPlaceOptions(selected) {
  const places = state.planning.places || [];
  return `<option value="">${mealText('meals.noSpecificPlace', 'No specific place')}</option>${places.map((place) => `
    <option value="${place.id}" ${Number(selected) === Number(place.id) ? 'selected' : ''} ${!place.active && Number(selected) !== Number(place.id) ? 'disabled' : ''}>${esc(place.name)}</option>
  `).join('')}`;
}

function renderMealPlanManagerActions() {
  if (!state.isAdmin) return '';
  const mutationContext = mealMutationContext();
  const randomizeDisabled = mutationContext.allowed ? '' : ' disabled';
  const randomizeTitle = mutationContext.allowed
    ? ''
    : ` title="${esc(mealText('meals.chooseContextBeforeEditing', 'Choose Home or a trip before changing this week.'))}"`;
  return `<div class="meal-plan-manager__actions" role="group" aria-label="${esc(mealText('meals.mealPlans', 'Meal Plans'))}">
    <button type="button" class="btn btn--primary" data-plan-create><i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>${mealText('meals.createMealPlan', 'Create Meal Plan')}</button>
    <button type="button" class="btn btn--secondary" data-plan-defaults><i data-lucide="settings-2" class="icon-sm" aria-hidden="true"></i>${mealText('meals.planDefaultSettings', 'Meal Plan Default Settings')}</button>
    <button type="button" class="btn btn--secondary" data-plan-randomize${randomizeDisabled}${randomizeTitle}><i data-lucide="shuffle" class="icon-sm" aria-hidden="true"></i>${t('meals.randomizePlan')}</button>
  </div>`;
}

function renderMealPlanManagerContent() {
  const model = activeWeekModel();
  const contextId = selectedNumericContextId();
  const context = collectMealContexts(model).find((item) => Number(item.id) === contextId);
  const contextPlans = model.context_plan?.plans || context?.meal_plans || [];
  const attachedIds = new Set(contextPlans.map((item) => Number(item.meal_plan_id ?? item.id)));
  const contextIntro = context ? `<div class="meal-plan-context-callout"><i data-lucide="${(context.context_type || context.type) === 'travel' ? 'plane' : 'map-pin'}" class="icon-sm" aria-hidden="true"></i><span><strong>${esc(context.name)}</strong><small>${mealText('meals.contextPlanHint', 'Choose which Meal Plan this planning context uses. Home rotation remains separate.')}</small></span></div>` : '';
  if (!state.mealPlans.length) {
    return `${contextIntro}${renderMealPlanManagerActions()}<div class="meal-plan-manager__empty"><i data-lucide="notebook-tabs" aria-hidden="true"></i><h3>${mealText('meals.noMealPlans', 'No Meal Plans yet')}</h3><p>${mealText('meals.noMealPlansHint', 'Create a reusable plan for the meal slots your household repeats.')}</p>${state.isAdmin ? '' : `<p class="form-hint">${mealText('meals.planAdminRequired', 'An administrator can create Meal Plans.')}</p>`}</div>`;
  }
  return `<div class="meal-plan-manager">${contextIntro}${renderMealPlanManagerActions()}<p class="form-hint">${mealText('meals.mealPlanManagerHint', 'Meal Plans define reusable meal slots. Editing a plan creates a new revision; dated meals remain reviewable.')}</p><div class="meal-plan-manager__list">${state.mealPlans.map((plan) => `
    <article class="meal-plan-row" data-plan-id="${plan.id}">
      <div><strong>${esc(plan.name)}</strong><span>${esc(plan.description || mealText('meals.noDescription', 'No description'))}</span><small>${mealText('meals.ruleCount', '{{count}} slots', { count: Number(plan.rule_count ?? plan.rules?.length ?? 0) })}${plan.effective_from ? ` · ${formatDate(plan.effective_from)}` : ''}${plan.effective_until ? ` - ${formatDate(plan.effective_until)}` : ''}</small></div>
      <span class="meal-plan-row__status meal-plan-row__status--${esc(plan.status || 'active')}">${esc(plan.status || 'active')}</span>
      <div class="meal-plan-row__actions">
        ${context && state.isAdmin ? attachedIds.has(Number(plan.id))
          ? `<button type="button" class="btn btn--secondary btn--sm" data-context-plan-detach="${plan.id}">${mealText('meals.detachPlan', 'Remove from context')}</button>`
          : plan.status === 'active' ? `<button type="button" class="btn btn--primary btn--sm" data-context-plan-attach="${plan.id}">${esc(mealText('meals.useForContext', 'Use for {{context}}', { context: context.name }))}</button>` : '' : ''}
        <button type="button" class="btn btn--secondary btn--sm" data-plan-view="${plan.id}">${mealText('meals.viewMealPlan', 'View')}</button>
        ${state.isAdmin ? `<button type="button" class="btn btn--secondary btn--sm" data-plan-edit="${plan.id}">${t('common.edit')}</button><button type="button" class="btn btn--ghost btn--sm" data-plan-delete="${plan.id}">${t('common.delete')}</button>` : ''}
      </div>
    </article>`).join('')}</div></div>`;
}

async function openMealPlanManager() {
  try {
    await loadMealPlans();
  } catch (error) {
    window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
    return;
  }
  openSharedModal({
    title: mealText('meals.mealPlans', 'Meal Plans'),
    content: renderMealPlanManagerContent(),
    size: 'lg',
    initialFocus: 'none',
    onSave(panel) {
      panel.querySelectorAll('[data-plan-create]').forEach((button) => button.addEventListener('click', () => openMealPlanEditor()));
      panel.querySelector('[data-plan-defaults]')?.addEventListener('click', openMealDefaultSettingsModal);
      panel.querySelector('[data-plan-randomize]')?.addEventListener('click', openRandomizeModal);
      const saveContextPlan = async (button, attach) => {
        button.disabled = true;
        try {
          const planId = Number(attach ? button.dataset.contextPlanAttach : button.dataset.contextPlanDetach);
          const contextId = Number(state.selectedContextId);
          if (attach) await api.put(`/meals/plans/${planId}/contexts/${contextId}`, { is_primary: true });
          else await api.delete(`/meals/plans/${planId}/contexts/${contextId}`);
          await Promise.all([loadWeek(state.currentWeek), loadWeekExperience()]);
          closeSharedModal({ force: true });
          renderWeekExperienceHeader();
          renderWeekGrid();
          window.yuvomi?.showToast(attach
            ? mealText('meals.contextPlanAttached', 'Meal Plan attached to this context.')
            : mealText('meals.contextPlanDetached', 'Meal Plan removed from this context.'), 'success');
        } catch (error) {
          window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
          button.disabled = false;
        }
      };
      panel.querySelectorAll('[data-context-plan-attach]').forEach((button) => button.addEventListener('click', () => saveContextPlan(button, true)));
      panel.querySelectorAll('[data-context-plan-detach]').forEach((button) => button.addEventListener('click', () => saveContextPlan(button, false)));
      panel.querySelectorAll('[data-plan-view]').forEach((button) => button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const response = await api.get(`/meals/plans/${Number(button.dataset.planView)}`);
          openMealPlanEditor(response?.data ?? response, { readOnly: true });
        } catch (error) {
          window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
          button.disabled = false;
        }
      }));
      panel.querySelectorAll('[data-plan-edit]').forEach((button) => button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const response = await api.get(`/meals/plans/${Number(button.dataset.planEdit)}`);
          openMealPlanEditor(response?.data ?? response);
        } catch (error) {
          window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
          button.disabled = false;
        }
      }));
      panel.querySelectorAll('[data-plan-delete]').forEach((button) => button.addEventListener('click', async () => {
        const plan = state.mealPlans.find((item) => Number(item.id) === Number(button.dataset.planDelete));
        const confirmed = await confirmOverModal(
          mealText('meals.deleteMealPlanTitle', 'Delete "{{name}}"?', { name: plan?.name || '' }),
          {
            detail: t('meals.deletePlanConfirmDetail'),
            confirmLabel: t('common.delete'),
            danger: true,
          },
        );
        if (!confirmed) return;
        try {
          await api.delete(`/meals/plans/${Number(button.dataset.planDelete)}`);
          window.yuvomi?.showToast(mealText('meals.mealPlanDeleted', 'Meal Plan deleted.'), 'success');
          await loadWeekExperience();
          renderWeekExperienceHeader();
          renderWeekGrid();
          openMealPlanManager();
        } catch (error) {
          window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
        }
      }));
      if (window.lucide) lucide.createIcons({ el: panel });
    },
  });
}

let _mealPlanRuleSequence = 0;

const EXECUTION_TASK_KINDS = [
  ['preparation', 'meals.rolePreparation', 'cook'],
  ['cooking', 'meals.roleCooking', 'cook'],
  ['supervision', 'meals.roleSupervision', 'supervisor'],
  ['serving', 'meals.roleServing', 'cook'],
  ['cleanup', 'meals.roleCleanup', 'cook'],
];

function durationEditorValue(minutes, preferredUnit = 'hours') {
  const value = Number(minutes ?? 0);
  if (preferredUnit === 'days' && value % 1440 === 0) return { value: value / 1440, unit: 'days' };
  if (value % 1440 === 0 && value >= 1440) return { value: value / 1440, unit: 'days' };
  if (value % 60 === 0 && value >= 60) return { value: value / 60, unit: 'hours' };
  return { value, unit: 'minutes' };
}

function durationUnitOptions(selected) {
  return [
    ['minutes', mealText('meals.unitMinutes', 'minutes')],
    ['hours', mealText('meals.unitHours', 'hours')],
    ['days', mealText('meals.unitDays', 'days')],
  ].map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
}

function mealPlanRulesForEditor(plan) {
  if (Array.isArray(plan?.slot_groups) && plan.slot_groups.length) return plan.slot_groups;
  const rules = plan?.rules || [];
  const groups = new Map();
  rules.forEach((rule, index) => {
    const key = rule.slot_group_key || `legacy:${rule.id || index}`;
    if (!groups.has(key)) groups.set(key, { ...rule, slot_group_key: rule.slot_group_key || null, weekdays: [] });
    groups.get(key).weekdays.push(Number(rule.weekday));
  });
  return [...groups.values()].map((rule) => ({ ...rule, weekdays: [...new Set(rule.weekdays)].sort((a, b) => a - b) }));
}

function strategyOptions(selected, choices) {
  return choices.map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
}

function renderChooserFallbackRow(selected = null) {
  return `<div class="meal-plan-fallback-row" data-plan-fallback-row>
    <label class="label"><span>${mealText('meals.fixedBackupChooser', 'Fixed backup chooser')}</span><select class="form-input" name="rule_fallback_user_id">${planMemberOptions(selected)}</select></label>
    <button type="button" class="btn btn--ghost btn--sm" data-plan-fallback-remove aria-label="${esc(mealText('meals.removeBackupChooser', 'Remove backup chooser'))}"><i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i></button>
  </div>`;
}

function renderMealPlanRule(rule = {}) {
  const sequence = ++_mealPlanRuleSequence;
  const participants = new Set((rule.participant_ids || rule.participants || [])
    .map((person) => Number(person?.user_id ?? person?.id ?? person)));
  const allParticipants = participants.size === 0;
  const members = state.weekModel?.members?.length ? state.weekModel.members : (state.planning.members || []);
  const weekdays = new Set((rule.weekdays?.length ? rule.weekdays : [rule.weekday ?? 0]).map(Number));
  const mealType = String(rule.meal_type || 'dinner');
  const fallbackIds = [...new Set((Array.isArray(rule.chooser_fallback_user_ids)
    ? rule.chooser_fallback_user_ids
    : rule.fallback_user_id ? [rule.fallback_user_id] : [])
    .map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const cookStrategy = rule.cook_strategy || (rule.cook_user_id ? 'fixed' : 'none');
  const supervisorStrategy = rule.supervisor_strategy || (rule.supervisor_user_id ? 'fixed' : 'none');
  const deadlineMode = rule.deadline_mode || 'relative';
  const deadline = durationEditorValue(rule.selection_deadline_value != null
    ? Number(rule.selection_deadline_value) * ({ minutes: 1, hours: 60, days: 1440 }[rule.selection_deadline_unit] || 1)
    : rule.selection_deadline_minutes ?? 1440, rule.selection_deadline_unit);
  const reminder = durationEditorValue(rule.reminder_value != null
    ? Number(rule.reminder_value) * ({ minutes: 1, hours: 60, days: 1440 }[rule.reminder_unit] || 1)
    : rule.reminder_minutes ?? 120, rule.reminder_unit);
  const assignments = typeof rule.execution_assignment_strategies === 'object' && rule.execution_assignment_strategies
    ? rule.execution_assignment_strategies : {};
  const strategyChoices = [
    ['cook', mealText('meals.assignToCook', 'Cook')],
    ['supervisor', mealText('meals.assignToSupervisor', 'Supervisor')],
    ['chooser', mealText('meals.assignToChooser', 'Meal chooser')],
    ['eligible_round_robin', mealText('meals.assignEligibleRoundRobin', 'Eligible round robin')],
    ['open_claimable', mealText('meals.assignOpenClaimable', 'Open / claimable')],
  ];
  const daySummary = [...weekdays].sort((a, b) => a - b).map((day) => DAY_NAMES()[day]).join(', ');
  const typeSummary = mealType === 'custom' ? (rule.custom_label || mealText('meals.customMeal', 'Custom')) : mealTypeLabel(mealType);
  return `<details class="meal-plan-rule" data-plan-rule data-rule-sequence="${sequence}" data-rule-id="${Number(rule.id) || ''}" data-rule-key="${esc(rule.rule_key || '')}" data-slot-group-key="${esc(rule.slot_group_key || '')}" open>
    <summary><span><strong data-rule-summary>${esc(rule.label || `${daySummary} — ${typeSummary}`)}</strong><small>${mealText('meals.repeatingMealSlot', 'Repeating meal slot')}</small></span><i data-lucide="chevron-down" class="icon-sm" aria-hidden="true"></i></summary>
    <div class="meal-plan-rule__body">
      <details class="meal-plan-rule__section" data-rule-section="day-meal" open><summary><span><strong>${mealText('meals.sectionDayMeal', 'Day & Meal')}</strong><small>${mealText('meals.sectionDayMealHint', 'Choose when and where this reusable meal slot appears.')}</small></span><i data-lucide="chevron-down" class="icon-sm" aria-hidden="true"></i></summary><div class="meal-plan-rule__section-body">
        <fieldset class="meal-plan-rule__weekdays"><legend>${mealText('meals.weekdaysLabel', 'Days of week')}</legend>${DAY_NAMES().map((day, index) => `<label class="meal-plan-weekday"><input type="checkbox" name="rule_weekday" value="${index}" ${weekdays.has(index) ? 'checked' : ''}><span>${day}</span></label>`).join('')}</fieldset>
        <div class="meal-plan-rule__grid">
          <label class="label">${t('meals.mealTypeLabel')}<select class="form-input" name="rule_meal_type">${MEAL_TYPES().map((type) => `<option value="${type.key}" ${mealType === type.key ? 'selected' : ''}>${type.label}</option>`).join('')}<option value="custom" ${mealType === 'custom' ? 'selected' : ''}>${mealText('meals.customMeal', 'Custom')}</option></select></label>
          <label class="label" data-plan-custom-label ${mealType === 'custom' ? '' : 'hidden'}>${mealText('meals.customMealName', 'Custom meal name')}<input class="form-input" name="rule_custom_label" maxlength="100" value="${esc(rule.custom_label || '')}" placeholder="${mealText('meals.customMealNameHint', 'e.g. Afternoon tea')}"></label>
          <label class="label">${mealText('meals.slotName', 'Slot name')}<input class="form-input" name="rule_label" maxlength="100" value="${esc(rule.label || '')}" placeholder="${mealText('meals.slotNamePlaceholder', 'e.g. Weeknight dinner')}"></label>
          <label class="label">${mealText('meals.placeLabel', 'Place')}<select class="form-input" name="rule_place_id">${planPlaceOptions(rule.place_id)}</select></label>
          <label class="label">${mealText('meals.earliestTime', 'Earliest')}<input class="form-input" type="time" name="rule_earliest_time" value="${esc(rule.earliest_time || '')}"></label>
          <label class="label">${mealText('meals.preferredTime', 'Preferred')}<input class="form-input" type="time" name="rule_preferred_time" value="${esc(rule.preferred_time || '')}"></label>
          <label class="label">${mealText('meals.latestTime', 'Latest')}<input class="form-input" type="time" name="rule_latest_time" value="${esc(rule.latest_time || '')}"></label>
          <label class="meal-inline-choice meal-plan-rule__active"><input type="checkbox" name="rule_active" ${rule.active !== false && rule.active !== 0 ? 'checked' : ''}><span>${mealText('meals.slotActive', 'Slot active')}</span></label>
        </div>
      </div></details>
      <details class="meal-plan-rule__section" data-rule-section="who" open><summary><span><strong>${mealText('meals.sectionWho', 'Who')}</strong><small>${mealText('meals.sectionWhoHint', 'Choose who decides, participates, cooks, and supervises.')}</small></span><i data-lucide="chevron-down" class="icon-sm" aria-hidden="true"></i></summary><div class="meal-plan-rule__section-body">
        <fieldset class="meal-plan-responsibility-group" data-plan-chooser-group><legend>${mealText('meals.chooserResponsibility', 'Chooser responsibility')}</legend>
          <div class="meal-plan-assignment-row">
            <label class="label"><span>${mealText('meals.selectionPolicy', 'Selection policy')}</span><select class="form-input" name="rule_policy"><option value="fixed" ${rule.policy === 'fixed' || !rule.policy ? 'selected' : ''}>${policyLabel('fixed')}</option><option value="round_robin" ${rule.policy === 'round_robin' ? 'selected' : ''}>${policyLabel('round_robin')}</option><option value="personal_choice" ${rule.policy === 'personal_choice' ? 'selected' : ''}>${policyLabel('personal_choice')}</option></select></label>
            <label class="label" data-plan-fixed><span>${mealText('meals.primaryChooser', 'Primary chooser')}</span><select class="form-input" name="rule_fixed_user_id">${planMemberOptions(rule.fixed_user_id)}</select><small class="form-hint">${mealText('meals.primaryChooserHint', 'This person normally chooses the household meal unless they are unavailable or decline.')}</small></label>
            <label class="label" data-plan-round-robin ${rule.policy === 'round_robin' ? '' : 'hidden'}><span>${mealText('meals.rotationGroupOptional', 'Round-robin group (optional)')}</span><input class="form-input" name="rule_rotation_group" maxlength="160" value="${esc(rule.rotation_group || '')}" placeholder="${mealText('meals.defaultEligibleGroup', 'Default - all eligible members')}"><small class="form-hint">${mealText('meals.rotationGroupOptionalHint', 'Leave blank to rotate through all eligible household members. An empty custom group falls back to that default.')}</small></label>
          </div>
          <div class="meal-plan-fallbacks" data-plan-fallbacks ${rule.policy === 'personal_choice' ? 'hidden' : ''}>
            <div><strong>${mealText('meals.fixedBackupOrder', 'Fixed backup order')}</strong><small>${mealText('meals.fixedBackupOrderHint', 'If the chooser cannot decide, Yuvomi tries these people in order, then uses the household default failsafe.')}</small></div>
            <div class="meal-plan-fallback-list" data-plan-fallback-list>${fallbackIds.map((id) => renderChooserFallbackRow(id)).join('')}</div>
            <button type="button" class="btn btn--secondary btn--sm" data-plan-fallback-add><i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>${mealText('meals.addBackupChooser', 'Add backup chooser')}</button>
            <small class="form-hint">${mealText('meals.defaultFailsafeManagedElsewhere', 'The final failsafe is configured once in Meal Plan Default Settings.')}</small>
          </div>
        </fieldset>
        <fieldset class="meal-plan-responsibility-group"><legend>${mealText('meals.cookAssignment', 'Cook assignment')}</legend><div class="meal-plan-assignment-row">
          <label class="label"><span>${mealText('meals.assignmentMethod', 'Assignment method')}</span><select class="form-input" name="rule_cook_strategy">${strategyOptions(cookStrategy, [['none', mealText('meals.strategyNone', 'None')], ['fixed', mealText('meals.fixedMember', 'Fixed member')], ['round_robin', mealText('meals.eligibleRoundRobin', 'Eligible round robin')]])}</select></label>
          <label class="label" data-plan-cook-fixed ${cookStrategy === 'fixed' ? '' : 'hidden'}><span>${mealText('meals.cookLabel', 'Cook')}</span><select class="form-input" name="rule_cook_user_id">${planMemberOptions(rule.cook_user_id)}</select></label>
          <label class="label" data-plan-cook-rotation ${cookStrategy === 'round_robin' ? '' : 'hidden'}><span>${mealText('meals.roundRobinGroupOptional', 'Round-robin group (optional)')}</span><input class="form-input" name="rule_cook_rotation_group" maxlength="160" value="${esc(rule.cook_rotation_group || '')}" placeholder="${mealText('meals.defaultEligibleGroup', 'Default - all eligible members')}"><small class="form-hint">${mealText('meals.roleRotationFallbackHint', 'Leave blank for eligible household members; an empty group falls back to that default.')}</small></label>
        </div></fieldset>
        <fieldset class="meal-plan-responsibility-group"><legend>${mealText('meals.supervisorAssignment', 'Supervisor assignment')}</legend><div class="meal-plan-assignment-row">
          <label class="label"><span>${mealText('meals.assignmentMethod', 'Assignment method')}</span><select class="form-input" name="rule_supervisor_strategy">${strategyOptions(supervisorStrategy, [['none', mealText('meals.strategyNone', 'None')], ['fixed', mealText('meals.fixedMember', 'Fixed member')], ['round_robin', mealText('meals.eligibleRoundRobin', 'Eligible round robin')]])}</select></label>
          <label class="label" data-plan-supervisor-fixed ${supervisorStrategy === 'fixed' ? '' : 'hidden'}><span>${mealText('meals.supervisorLabel', 'Supervisor')}</span><select class="form-input" name="rule_supervisor_user_id">${planMemberOptions(rule.supervisor_user_id)}</select></label>
          <label class="label" data-plan-supervisor-rotation ${supervisorStrategy === 'round_robin' ? '' : 'hidden'}><span>${mealText('meals.roundRobinGroupOptional', 'Round-robin group (optional)')}</span><input class="form-input" name="rule_supervisor_rotation_group" maxlength="160" value="${esc(rule.supervisor_rotation_group || '')}" placeholder="${mealText('meals.defaultEligibleGroup', 'Default - all eligible members')}"><small class="form-hint">${mealText('meals.roleRotationFallbackHint', 'Leave blank for eligible household members; an empty group falls back to that default.')}</small></label>
        </div></fieldset>
        <label class="meal-inline-choice meal-plan-rule__presence"><input type="checkbox" name="rule_presence_required" ${rule.presence_required ? 'checked' : ''}><span>${mealText('meals.presenceRequired', 'Only assign people who are available in this context')}</span></label>
        <details class="meal-plan-rule__participants" data-participant-override ${allParticipants ? '' : 'open'}><summary><span><strong>${mealText('meals.manualParticipants', 'Manual participant override')}</strong><small>${mealText('meals.manualParticipantsHint', 'By default, every household member participates and new members are included automatically.')}</small></span><i data-lucide="chevron-down" class="icon-sm" aria-hidden="true"></i></summary><div class="meal-plan-rule__participants-body"><label class="meal-inline-choice meal-plan-rule__all-participants"><input type="checkbox" name="rule_all_participants" ${allParticipants ? 'checked' : ''}><span>${mealText('meals.allHouseholdMembers', 'All household members')}</span></label><div data-plan-participant-list ${allParticipants ? 'hidden' : ''}>${members.map((member) => `<label class="meal-inline-choice"><input type="checkbox" name="rule_participant" value="${member.id}" ${participants.has(Number(member.id)) ? 'checked' : ''} ${allParticipants ? 'disabled' : ''}><span>${esc(member.display_name || member.name)}</span></label>`).join('') || `<span class="form-hint">${mealText('meals.noMembers', 'No household members found.')}</span>`}</div></div></details>
      </div></details>
      <details class="meal-plan-rule__section" data-rule-section="what" open><summary><span><strong>${mealText('meals.sectionWhat', 'What')}</strong><small>${mealText('meals.sectionWhatHint', 'Choose the practical Tasks Yuvomi creates when this meal is prepared.')}</small></span><i data-lucide="chevron-down" class="icon-sm" aria-hidden="true"></i></summary><div class="meal-plan-rule__section-body">
        <p class="form-hint">${mealText('meals.executionTasksPlainHint', 'These are real household Tasks. Each one follows the Cook, Supervisor, chooser, or eligible round-robin responsibility selected below.')}</p>
        <div class="meal-plan-rule__durations"><label class="label">${mealText('meals.expectedDurationMinutes', 'Expected meal duration (minutes)')}<input class="form-input" type="number" min="1" max="720" name="rule_expected_minutes" value="${Number(rule.expected_duration_minutes ?? 60)}"></label><label class="label">${mealText('meals.preparationMinutes', 'Preparation lead before meal (minutes)')}<input class="form-input" type="number" min="0" max="1440" name="rule_preparation_minutes" value="${Number(rule.preparation_duration_minutes ?? 60)}"></label><label class="label">${mealText('meals.cookingMinutes', 'Cooking lead before meal (minutes)')}<input class="form-input" type="number" min="0" max="1440" name="rule_cooking_minutes" value="${Number(rule.cooking_duration_minutes ?? rule.expected_duration_minutes ?? 30)}"></label><label class="label">${mealText('meals.cleanupMinutes', 'Cleanup after meal starts (minutes)')}<input class="form-input" type="number" min="0" max="1440" name="rule_cleanup_minutes" value="${Number(rule.cleanup_duration_minutes ?? 60)}"></label></div>
        <fieldset class="meal-plan-rule__tasks"><legend>${mealText('meals.executionTaskRoles', 'Meal execution Tasks')}</legend>${EXECUTION_TASK_KINDS.map(([kind, labelKey, legacyDefault]) => {
          const enabled = rule[`generate_${kind}`] !== false && rule[`generate_${kind}`] !== 0;
          return `<div class="meal-plan-task-kind" data-task-kind="${kind}"><label class="meal-inline-choice"><input type="checkbox" name="rule_generate_${kind}" ${enabled ? 'checked' : ''}><span>${t(labelKey)}</span></label><label class="label" data-task-assignment ${enabled ? '' : 'hidden'}>${mealText('meals.taskAssignmentStrategy', 'Assign to')}<select class="form-input" name="rule_assignment_${kind}">${strategyOptions(assignments[kind] || legacyDefault, strategyChoices)}</select></label></div>`;
        }).join('')}</fieldset>
      </div></details>
      <details class="meal-plan-rule__section" data-rule-section="deadlines" open><summary><span><strong>${mealText('meals.sectionDeadlines', 'Deadlines')}</strong><small>${mealText('meals.sectionDeadlinesHint', 'Set when meal choices are due and when Yuvomi reminds people.')}</small></span><i data-lucide="chevron-down" class="icon-sm" aria-hidden="true"></i></summary><div class="meal-plan-rule__section-body">
        <div class="meal-plan-deadlines-grid">
          <label class="label"><span class="meal-plan-field-label">${mealText('meals.deadlineMode', 'Choice deadline')}</span><select class="form-input" name="rule_deadline_mode"><option value="relative" ${deadlineMode === 'relative' ? 'selected' : ''}>${mealText('meals.deadlineRelative', 'Before each meal')}</option><option value="weekly_cutoff" ${deadlineMode === 'weekly_cutoff' ? 'selected' : ''}>${mealText('meals.deadlineWeekly', 'Weekly cutoff')}</option></select></label>
          <div class="meal-plan-duration" data-deadline-relative ${deadlineMode === 'relative' ? '' : 'hidden'}><label class="label"><span class="meal-plan-field-label">${mealText('meals.deadlineAmount', 'Due before meal')}</span><input class="form-input" type="number" min="0" step="1" name="rule_deadline_value" value="${deadline.value}"></label><label class="label"><span class="meal-plan-field-label">${mealText('meals.deadlineUnit', 'Unit')}</span><select class="form-input" name="rule_deadline_unit">${durationUnitOptions(rule.selection_deadline_unit || deadline.unit)}</select></label></div>
          <div class="meal-plan-duration" data-deadline-weekly ${deadlineMode === 'weekly_cutoff' ? '' : 'hidden'}><label class="label"><span class="meal-plan-field-label">${mealText('meals.cutoffWeekday', 'Previous week day')}</span><select class="form-input" name="rule_deadline_weekday">${DAY_NAMES().map((day, index) => `<option value="${index}" ${Number(rule.deadline_weekday ?? 6) === index ? 'selected' : ''}>${day}</option>`).join('')}</select></label><label class="label"><span class="meal-plan-field-label">${mealText('meals.cutoffTime', 'Cutoff time')}</span><input class="form-input" type="time" name="rule_deadline_time" value="${esc(rule.deadline_time || '18:00')}"></label><small class="form-hint meal-plan-duration__hint">${mealText('meals.cutoffPreviousWeekHint', 'This cutoff is always in the previous week, before these meal days.')}</small></div>
          <div class="meal-plan-duration"><label class="label"><span class="meal-plan-field-label">${mealText('meals.reminderLead', 'Reminder before deadline')}</span><input class="form-input" type="number" min="0" step="1" name="rule_reminder_value" value="${reminder.value}"></label><label class="label"><span class="meal-plan-field-label">${mealText('meals.deadlineUnit', 'Unit')}</span><select class="form-input" name="rule_reminder_unit">${durationUnitOptions(reminder.unit)}</select></label></div>
          <div class="meal-plan-choice-limits"><div><strong>${mealText('meals.mealOptionLimits', 'Household menu limits')}</strong><small>${mealText('meals.mealOptionLimitsHint', 'Set separate maximums for entrées and sides. Each can be from 0 to 9.')}</small></div><label class="label"><span class="meal-plan-field-label">${mealText('meals.maxEntrees', 'Maximum entrées')}</span><input class="form-input" type="number" min="0" max="9" name="rule_max_entrees" value="${Number(rule.max_entree_choices ?? 1)}"></label><label class="label"><span class="meal-plan-field-label">${mealText('meals.maxSides', 'Maximum sides')}</span><input class="form-input" type="number" min="0" max="9" name="rule_max_sides" value="${Number(rule.max_side_choices ?? rule.choice_limit ?? rule.snack_choice_limit ?? 3)}"></label></div>
        </div>
      </div></details>
      <button type="button" class="btn btn--ghost btn--sm meal-plan-rule__remove" data-plan-rule-remove><i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i>${mealText('meals.removeSlot', 'Remove slot')}</button>
    </div>
  </details>`;
}

function planRuleFromElement(rule) {
  const value = (name) => rule.querySelector(`[name="${name}"]`)?.value || '';
  const weekdays = [...rule.querySelectorAll('[name="rule_weekday"]:checked')].map((input) => Number(input.value));
  const toMinutes = (amount, unit) => Math.round(Number(amount || 0) * ({ minutes: 1, hours: 60, days: 1440 }[unit] || 1));
  const deadlineMode = value('rule_deadline_mode') || 'relative';
  const deadlineValue = Number(value('rule_deadline_value') || 0);
  const deadlineUnit = value('rule_deadline_unit') || 'hours';
  const reminderValue = Number(value('rule_reminder_value') || 0);
  const reminderUnit = value('rule_reminder_unit') || 'hours';
  const policy = value('rule_policy');
  const fallbackUserIds = [...new Set([...rule.querySelectorAll('[name="rule_fallback_user_id"]')]
    .map((select) => Number(select.value))
    .filter((id) => Number.isInteger(id) && id > 0))];
  const cookStrategy = value('rule_cook_strategy') || 'none';
  const supervisorStrategy = value('rule_supervisor_strategy') || 'none';
  const maxEntreeChoices = Math.min(9, Math.max(0, Number(value('rule_max_entrees') || 0)));
  const maxSideChoices = Math.min(9, Math.max(0, Number(value('rule_max_sides') || 0)));
  const executionAssignmentStrategies = Object.fromEntries(EXECUTION_TASK_KINDS.map(([kind]) => (
    [kind, value(`rule_assignment_${kind}`)]
  )));
  return {
    id: Number(rule.dataset.ruleId) || null,
    rule_key: rule.dataset.ruleKey || null,
    slot_group_key: rule.dataset.slotGroupKey || null,
    weekday: weekdays[0],
    weekdays,
    meal_type: value('rule_meal_type'),
    custom_label: value('rule_meal_type') === 'custom' ? value('rule_custom_label').trim() || null : null,
    label: value('rule_label').trim() || null,
    policy,
    fixed_user_id: policy === 'fixed' ? Number(value('rule_fixed_user_id')) || null : null,
    rotation_group: policy === 'round_robin' ? value('rule_rotation_group').trim() || null : null,
    chooser_fallback_user_ids: policy === 'personal_choice' ? [] : fallbackUserIds,
    // Compatibility fields remain populated while older clients and copied
    // databases transition to the ordered chain introduced in schema 10019.
    chooser_backup_strategy: policy !== 'personal_choice' && fallbackUserIds.length ? 'fixed' : 'next_eligible',
    fallback_user_id: policy !== 'personal_choice' ? fallbackUserIds[0] || null : null,
    cook_strategy: cookStrategy,
    cook_user_id: cookStrategy === 'fixed' ? Number(value('rule_cook_user_id')) || null : null,
    cook_rotation_group: cookStrategy === 'round_robin' ? value('rule_cook_rotation_group').trim() || null : null,
    supervisor_strategy: supervisorStrategy,
    supervisor_user_id: supervisorStrategy === 'fixed' ? Number(value('rule_supervisor_user_id')) || null : null,
    supervisor_rotation_group: supervisorStrategy === 'round_robin' ? value('rule_supervisor_rotation_group').trim() || null : null,
    participant_ids: rule.querySelector('[name="rule_all_participants"]')?.checked
      ? []
      : [...rule.querySelectorAll('[name="rule_participant"]:checked')].map((input) => Number(input.value)),
    place_id: Number(value('rule_place_id')) || null,
    earliest_time: value('rule_earliest_time') || null,
    preferred_time: value('rule_preferred_time') || null,
    latest_time: value('rule_latest_time') || null,
    preparation_duration_minutes: Number(value('rule_preparation_minutes') || 0),
    cooking_duration_minutes: Number(value('rule_cooking_minutes') || 0),
    cleanup_duration_minutes: Number(value('rule_cleanup_minutes') || 0),
    expected_duration_minutes: Number(value('rule_expected_minutes') || 60),
    deadline_mode: deadlineMode,
    selection_deadline_value: deadlineValue,
    selection_deadline_unit: deadlineUnit,
    selection_deadline_minutes: toMinutes(deadlineValue, deadlineUnit),
    deadline_weekday: deadlineMode === 'weekly_cutoff' ? Number(value('rule_deadline_weekday')) : null,
    deadline_time: deadlineMode === 'weekly_cutoff' ? value('rule_deadline_time') || null : null,
    reminder_value: reminderValue,
    reminder_unit: reminderUnit,
    reminder_minutes: toMinutes(reminderValue, reminderUnit),
    max_entree_choices: maxEntreeChoices,
    max_side_choices: maxSideChoices,
    // Released schemas require legacy choice_limit >= 1. Modern zero-side
    // Meals are represented by max_side_choices while compatibility remains
    // valid for older readers.
    choice_limit: Math.max(1, maxSideChoices),
    presence_required: Boolean(rule.querySelector('[name="rule_presence_required"]')?.checked),
    generate_preparation: Boolean(rule.querySelector('[name="rule_generate_preparation"]')?.checked),
    generate_cooking: Boolean(rule.querySelector('[name="rule_generate_cooking"]')?.checked),
    generate_supervision: Boolean(rule.querySelector('[name="rule_generate_supervision"]')?.checked),
    generate_serving: Boolean(rule.querySelector('[name="rule_generate_serving"]')?.checked),
    generate_cleanup: Boolean(rule.querySelector('[name="rule_generate_cleanup"]')?.checked),
    execution_assignment_strategies: executionAssignmentStrategies,
    active: Boolean(rule.querySelector('[name="rule_active"]')?.checked),
  };
}

function renderMealPlanRevisionHistory(plan) {
  const revisions = Array.isArray(plan?.revisions) ? plan.revisions : [];
  if (!revisions.length) return '';
  return `<section class="meal-plan-history" aria-labelledby="meal-plan-history-heading">
    <div class="meal-plan-editor__heading"><h3 id="meal-plan-history-heading">${mealText('meals.revisionHistory', 'Revision history')}</h3><span>${mealText('meals.currentRevision', 'Current revision {{revision}}', { revision: Number(plan.current_revision ?? plan.revision ?? 1) })}</span></div>
    <ol>${revisions.map((revision) => `<li>
      <strong>${mealText('meals.revisionNumber', 'Revision {{revision}}', { revision: Number(revision.revision) })}</strong>
      <span>${revision.created_at ? formatDate(String(revision.created_at).slice(0, 10)) : ''}</span>
      <small>${esc(revision.change_note || mealText('meals.noRevisionNote', 'No change summary recorded.'))}</small>
    </li>`).join('')}</ol>
  </section>`;
}

function openMealPlanEditor(plan = null, { readOnly = false } = {}) {
  const rules = mealPlanRulesForEditor(plan);
  if (!rules.length) rules.push({ weekdays: [0], meal_type: 'dinner', policy: 'fixed', chooser_fallback_user_ids: [], participant_ids: [] });
  const content = `<form id="meal-plan-form" class="meal-plan-editor">
    <p class="form-hint">${mealText('meals.mealPlanEditorHint', 'Define reusable weekly slots. Dated meals remain independently editable after the plan creates them.')}</p>
    <div class="meal-plan-editor__identity">
      <label class="label meal-plan-editor__name">${mealText('meals.planName', 'Plan name')}<input class="form-input" name="name" maxlength="120" required value="${esc(plan?.name || '')}" placeholder="${mealText('meals.planNamePlaceholder', 'e.g. School-week meals')}"></label>
      <label class="meal-inline-choice meal-plan-editor__active"><input type="checkbox" name="active" ${plan?.status !== 'archived' ? 'checked' : ''}><span><strong>${mealText('meals.planActiveQuestion', 'Active?')}</strong><small>${mealText('meals.planActiveHint', 'When off, this plan never creates meals, even inside its effective dates.')}</small></span></label>
      <label class="label meal-plan-editor__description">${mealText('meals.planDescription', 'Description')}<textarea class="form-input" name="description" rows="2">${esc(plan?.description || '')}</textarea></label>
      <div class="meal-plan-editor__dates"><label class="label">${mealText('meals.effectiveFrom', 'Effective from')}<input class="form-input" type="date" name="effective_from" value="${esc(plan?.effective_from || '')}"></label><label class="label">${mealText('meals.effectiveUntil', 'Effective until')}<input class="form-input" type="date" name="effective_until" value="${esc(plan?.effective_until || '')}"></label><small class="form-hint">${mealText('meals.planActivationHint', 'When Active is on, these dates control the plan window. Turning Active off always overrides the dates.')}</small></div>
      ${plan?.id && !readOnly ? `<label class="label meal-plan-editor__description">${mealText('meals.changeSummary', 'Change summary')}<textarea class="form-input" name="change_note" rows="2" maxlength="1000" placeholder="${mealText('meals.changeSummaryPlaceholder', 'What changed in this revision?')}"></textarea></label>` : ''}
    </div>
    <div class="meal-plan-editor__heading"><h3>${mealText('meals.planSlots', 'Meal slots')}</h3>${readOnly ? '' : `<button type="button" class="btn btn--secondary btn--sm" data-plan-rule-add><i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>${mealText('meals.addSlot', 'Add slot')}</button>`}</div>
    <div class="meal-plan-editor__rules" data-plan-rules>${rules.map(renderMealPlanRule).join('')}</div>
    ${renderMealPlanRevisionHistory(plan)}
    <div class="modal-panel__footer modal-panel__footer--plain"><button type="button" class="btn btn--secondary" data-action="close-modal">${readOnly ? t('common.close') : t('common.cancel')}</button>${readOnly ? '' : `<button type="submit" class="btn btn--primary">${plan?.id ? t('common.save') : mealText('meals.createMealPlan', 'Create Meal Plan')}</button>`}</div>
  </form>`;
  openSharedModal({ title: readOnly ? mealText('meals.viewMealPlanTitle', 'Meal Plan details') : plan?.id ? mealText('meals.editMealPlan', 'Edit Meal Plan') : mealText('meals.addMealPlan', 'Meal Plan'), content, size: 'xl', onSave(panel) {
    if (readOnly) {
      panel.querySelectorAll('input, select, textarea, [data-plan-rule-remove], [data-plan-fallback-add], [data-plan-fallback-remove]').forEach((field) => { field.disabled = true; });
      panel.querySelectorAll('[data-plan-rule-remove], [data-plan-fallback-add], [data-plan-fallback-remove]').forEach((button) => { button.hidden = true; });
      if (window.lucide) lucide.createIcons({ el: panel });
      return;
    }
    const rulesEl = panel.querySelector('[data-plan-rules]');
    const syncRule = (rule) => {
      const policy = rule.querySelector('[name="rule_policy"]')?.value;
      const mealType = rule.querySelector('[name="rule_meal_type"]')?.value;
      const cookStrategy = rule.querySelector('[name="rule_cook_strategy"]')?.value;
      const supervisorStrategy = rule.querySelector('[name="rule_supervisor_strategy"]')?.value;
      const deadlineMode = rule.querySelector('[name="rule_deadline_mode"]')?.value;
      const customLabel = rule.querySelector('[name="rule_custom_label"]');
      const customLabelWrap = rule.querySelector('[data-plan-custom-label]');
      if (customLabelWrap) customLabelWrap.hidden = mealType !== 'custom';
      if (customLabel) customLabel.required = mealType === 'custom';
      const fixed = rule.querySelector('[data-plan-fixed]');
      if (fixed) fixed.hidden = policy !== 'fixed';
      const rotation = rule.querySelector('[data-plan-round-robin]');
      if (rotation) rotation.hidden = policy !== 'round_robin';
      const fallbacks = rule.querySelector('[data-plan-fallbacks]');
      if (fallbacks) fallbacks.hidden = policy === 'personal_choice';
      rule.querySelectorAll('[name="rule_fallback_user_id"]').forEach((select) => {
        select.disabled = policy === 'personal_choice';
      });
      const cookFixed = rule.querySelector('[data-plan-cook-fixed]');
      if (cookFixed) cookFixed.hidden = cookStrategy !== 'fixed';
      const cookRotation = rule.querySelector('[data-plan-cook-rotation]');
      if (cookRotation) cookRotation.hidden = cookStrategy !== 'round_robin';
      const supervisorFixed = rule.querySelector('[data-plan-supervisor-fixed]');
      if (supervisorFixed) supervisorFixed.hidden = supervisorStrategy !== 'fixed';
      const supervisorRotation = rule.querySelector('[data-plan-supervisor-rotation]');
      if (supervisorRotation) supervisorRotation.hidden = supervisorStrategy !== 'round_robin';
      const relativeDeadline = rule.querySelector('[data-deadline-relative]');
      if (relativeDeadline) relativeDeadline.hidden = deadlineMode !== 'relative';
      const weeklyDeadline = rule.querySelector('[data-deadline-weekly]');
      if (weeklyDeadline) weeklyDeadline.hidden = deadlineMode !== 'weekly_cutoff';
      rule.querySelectorAll('[data-task-kind]').forEach((taskKind) => {
        const enabled = taskKind.querySelector('input[type="checkbox"]')?.checked;
        const assignment = taskKind.querySelector('[data-task-assignment]');
        if (assignment) assignment.hidden = !enabled;
      });
      const days = [...rule.querySelectorAll('[name="rule_weekday"]:checked')]
        .map((input) => DAY_NAMES()[Number(input.value)])
        .filter(Boolean)
        .join(', ');
      const type = mealType === 'custom'
        ? customLabel?.value.trim() || mealText('meals.customMeal', 'Custom')
        : mealTypeLabel(mealType);
      const label = rule.querySelector('[name="rule_label"]')?.value.trim();
      const summary = rule.querySelector('[data-rule-summary]');
      if (summary) summary.textContent = label || `${days || mealText('meals.chooseWeekday', 'Choose a day')} — ${type}`;
    };
    const wireRule = (rule) => {
      const allParticipants = rule.querySelector('[name="rule_all_participants"]');
      const syncParticipants = () => {
        const participantList = rule.querySelector('[data-plan-participant-list]');
        if (participantList) participantList.hidden = Boolean(allParticipants?.checked);
        rule.querySelectorAll('[name="rule_participant"]').forEach((input) => {
          input.disabled = Boolean(allParticipants?.checked);
        });
      };
      const fallbackList = rule.querySelector('[data-plan-fallback-list]');
      const syncFallbackChoices = () => {
        const selects = [...rule.querySelectorAll('[name="rule_fallback_user_id"]')];
        const used = new Set(selects.map((select) => Number(select.value)).filter(Boolean));
        selects.forEach((select) => {
          const own = Number(select.value);
          [...select.options].forEach((option) => {
            const id = Number(option.value);
            option.disabled = Boolean(id && id !== own && used.has(id));
          });
        });
        const add = rule.querySelector('[data-plan-fallback-add]');
        const memberCount = (state.weekModel?.members || state.planning.members || []).length;
        if (add) add.disabled = used.size >= memberCount;
      };
      const wireFallbackRow = (row) => {
        row.querySelector('[data-plan-fallback-remove]')?.addEventListener('click', () => {
          row.remove();
          syncFallbackChoices();
        });
        row.querySelector('[name="rule_fallback_user_id"]')?.addEventListener('change', syncFallbackChoices);
      };
      fallbackList?.querySelectorAll('[data-plan-fallback-row]').forEach(wireFallbackRow);
      rule.querySelector('[data-plan-fallback-add]')?.addEventListener('click', () => {
        fallbackList.insertAdjacentHTML('beforeend', renderChooserFallbackRow());
        const row = fallbackList.lastElementChild;
        wireFallbackRow(row);
        syncFallbackChoices();
        if (window.lucide) lucide.createIcons({ el: row });
        row.querySelector('select')?.focus();
      });
      syncRule(rule);
      syncParticipants();
      syncFallbackChoices();
      rule.querySelectorAll('select, input').forEach((field) => field.addEventListener('change', () => syncRule(rule)));
      allParticipants?.addEventListener('change', syncParticipants);
      rule.querySelectorAll('[name="rule_label"], [name="rule_custom_label"]').forEach((field) => field.addEventListener('input', () => syncRule(rule)));
      rule.querySelector('[data-plan-rule-remove]')?.addEventListener('click', () => {
        if (rulesEl.querySelectorAll('[data-plan-rule]').length === 1) {
          window.yuvomi?.showToast(mealText('meals.planNeedsSlot', 'A Meal Plan needs at least one slot.'), 'warning');
          return;
        }
        rule.remove();
      });
    };
    rulesEl.querySelectorAll('[data-plan-rule]').forEach(wireRule);
    panel.querySelector('[data-plan-rule-add]')?.addEventListener('click', () => {
      rulesEl.insertAdjacentHTML('beforeend', renderMealPlanRule({ weekdays: [0], meal_type: 'dinner', policy: 'fixed', chooser_fallback_user_ids: [], participant_ids: [] }));
      const rule = rulesEl.lastElementChild;
      wireRule(rule);
      if (window.lucide) lucide.createIcons({ el: rule });
      rule.querySelector('[name="rule_weekday"]')?.focus();
    });
    panel.querySelector('#meal-plan-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const submit = panel.querySelector('[type="submit"]');
      submit.disabled = true;
      const emptyWeekdayRule = [...form.querySelectorAll('[data-plan-rule]')].find((rule) => (
        !rule.querySelector('[name="rule_weekday"]:checked')
      ));
      if (emptyWeekdayRule) {
        window.yuvomi?.showToast(mealText('meals.chooseWeekday', 'Choose at least one day for every meal slot.'), 'warning');
        emptyWeekdayRule.querySelector('[name="rule_weekday"]')?.focus();
        submit.disabled = false;
        return;
      }
      const missingCustomLabelRule = [...form.querySelectorAll('[data-plan-rule]')].find((rule) => (
        rule.querySelector('[name="rule_meal_type"]')?.value === 'custom'
        && !rule.querySelector('[name="rule_custom_label"]')?.value.trim()
      ));
      if (missingCustomLabelRule) {
        window.yuvomi?.showToast(mealText('meals.customMealNameRequired', 'Name every Custom meal slot.'), 'warning');
        missingCustomLabelRule.querySelector('[name="rule_custom_label"]')?.focus();
        submit.disabled = false;
        return;
      }
      const payload = {
        name: String(data.get('name') || '').trim(),
        description: String(data.get('description') || '').trim() || null,
        status: data.has('active') ? 'active' : 'archived',
        effective_from: data.get('effective_from') || null,
        effective_until: data.get('effective_until') || null,
        change_note: String(data.get('change_note') || '').trim() || undefined,
        rules: [...form.querySelectorAll('[data-plan-rule]')].map(planRuleFromElement),
      };
      const emptyParticipantRule = [...form.querySelectorAll('[data-plan-rule]')].find((rule) => (
        !rule.querySelector('[name="rule_all_participants"]')?.checked
        && !rule.querySelector('[name="rule_participant"]:checked')
      ));
      if (emptyParticipantRule) {
        window.yuvomi?.showToast(mealText('meals.chooseParticipants', 'Choose at least one participant or select All household members.'), 'warning');
        emptyParticipantRule.querySelector('[name="rule_all_participants"]')?.focus();
        submit.disabled = false;
        return;
      }
      try {
        let saved;
        if (plan?.id) saved = await api.put(`/meals/plans/${plan.id}`, payload);
        else saved = await api.post('/meals/plans', payload);
        const contextId = selectedNumericContextId();
        const savedPlanId = Number(saved?.data?.id ?? saved?.id);
        if (!plan?.id && contextId && savedPlanId) {
          await api.put(`/meals/plans/${savedPlanId}/contexts/${contextId}`, { is_primary: true });
        }
        closeSharedModal({ force: true });
        await Promise.all([loadWeek(state.currentWeek), loadWeekExperience()]);
        renderWeekExperienceHeader();
        renderWeekGrid();
        window.yuvomi?.showToast(mealText('meals.mealPlanSaved', 'Meal Plan saved.'), 'success');
      } catch (error) {
        window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
        submit.disabled = false;
      }
    });
    if (window.lucide) lucide.createIcons({ el: panel });
  }});
}

async function openMealGrocerySettings() {
  let settings;
  try {
    const response = await api.get('/meals/grocery-settings');
    settings = response?.data ?? response ?? {};
    state.grocerySettings = settings;
  } catch (error) {
    window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
    return;
  }
  const listOptions = state.lists.map((list) => `<option value="${list.id}" ${Number(settings.default_shopping_list_id) === Number(list.id) ? 'selected' : ''}>${esc(list.name)}</option>`).join('');
  const content = `<form id="meal-grocery-settings-form" class="meal-grocery-settings">
    <p class="form-hint">${mealText('meals.grocerySettingsHint', 'These Shopping defaults are independent from Meal Plan schedules and cooking responsibilities.')}</p>
    <label class="meal-automation__master"><input type="checkbox" name="enabled" ${settings.enabled !== false && settings.enabled !== 0 ? 'checked' : ''}><span><strong>${mealText('meals.enableGroceryPreparation', 'Enable grocery preparation')}</strong><small>${t('meals.enableAutomationHint')}</small></span></label>
    <label class="form-label">${t('meals.defaultShoppingList')}<select class="form-input" name="default_shopping_list_id"><option value="">${t('meals.noDefaultShoppingList')}</option>${listOptions}</select></label>
    <label class="meal-automation__toggle"><input type="checkbox" name="auto_create_grocery_draft" ${settings.auto_create_grocery_draft !== false && settings.auto_create_grocery_draft !== 0 ? 'checked' : ''}><span>${t('meals.autoCreateGroceryDraft')}</span></label>
    <label class="meal-automation__toggle"><input type="checkbox" name="auto_finalize_grocery" ${settings.auto_finalize_grocery ? 'checked' : ''}><span>${t('meals.autoFinalizeGrocery')}<small>${t('meals.autoFinalizeGroceryHint')}</small></span></label>
    <label class="label">${mealText('meals.groceryLeadMinutes', 'Prepare grocery draft before meals (minutes)')}<input class="form-input" type="number" min="0" max="10080" name="grocery_lead_minutes" value="${Number(settings.grocery_lead_minutes ?? 1440)}"></label>
    <label class="label">${mealText('meals.groceryAggregation', 'Group grocery items by')}<select class="form-input" name="aggregation_mode"><option value="ingredient" ${settings.aggregation_mode === 'ingredient' || !settings.aggregation_mode ? 'selected' : ''}>${mealText('meals.aggregateIngredient', 'Ingredient')}</option><option value="meal" ${settings.aggregation_mode === 'meal' ? 'selected' : ''}>${mealText('meals.aggregateMeal', 'Meal')}</option><option value="recipe" ${settings.aggregation_mode === 'recipe' ? 'selected' : ''}>${mealText('meals.aggregateRecipe', 'Recipe')}</option></select></label>
    <div class="modal-panel__footer modal-panel__footer--plain"><button type="button" class="btn btn--secondary" data-action="close-modal">${t('common.cancel')}</button><button type="submit" class="btn btn--primary">${t('common.save')}</button></div>
  </form>`;
  openSharedModal({ title: mealText('meals.grocerySettings', 'Grocery settings'), content, size: 'md', onSave(panel) {
    panel.querySelector('#meal-grocery-settings-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const submit = panel.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const response = await api.put('/meals/grocery-settings', {
          enabled: data.has('enabled'),
          default_shopping_list_id: Number(data.get('default_shopping_list_id')) || null,
          auto_create_grocery_draft: data.has('auto_create_grocery_draft'),
          auto_finalize_grocery: data.has('auto_finalize_grocery'),
          grocery_lead_minutes: Number(data.get('grocery_lead_minutes') || 0),
          aggregation_mode: data.get('aggregation_mode'),
        });
        state.grocerySettings = response?.data ?? response;
        closeSharedModal({ force: true });
        window.yuvomi?.showToast(mealText('meals.grocerySettingsSaved', 'Grocery settings saved.'), 'success');
      } catch (error) {
        window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
        submit.disabled = false;
      }
    });
  }});
}

async function openMealDefaultSettingsModal() {
  const [groceryResult, defaultsResult] = await Promise.allSettled([
    api.get('/meals/grocery-settings'),
    api.get('/meals/plan-defaults'),
  ]);
  if (groceryResult.status === 'rejected' || defaultsResult.status === 'rejected') {
    const error = groceryResult.status === 'rejected' ? groceryResult.reason : defaultsResult.reason;
    window.yuvomi?.showToast(error?.data?.error || error?.message || t('common.unknownError'), 'danger');
    return;
  }
  const execution = state.planning.execution_settings || {};
  const grocery = groceryResult.value?.data ?? groceryResult.value ?? {};
  const defaults = defaultsResult.value?.data ?? defaultsResult.value ?? {};
  state.grocerySettings = grocery;
  const members = state.weekModel?.members?.length ? state.weekModel.members : (state.planning.members || []);
  const terminalStrategy = defaults.chooser_terminal_strategy || 'eligible_round_robin';
  const terminalRotation = new Set((defaults.chooser_round_robin_user_ids || []).map(Number));
  const selectedListId = Number(grocery.default_shopping_list_id || execution.default_shopping_list_id) || null;
  const listOptions = state.lists.map((list) => `<option value="${list.id}" ${selectedListId === Number(list.id) ? 'selected' : ''}>${esc(list.name)}</option>`).join('');
  const roleToggle = (key, labelKey) => `<label class="meal-automation__toggle"><input type="checkbox" name="generate_${key}" ${execution[`generate_${key}`] !== 0 ? 'checked' : ''}><span>${esc(t(labelKey))}</span></label>`;
  const noLists = state.lists.length === 0;
  const content = `<form id="meal-default-settings-form" class="meal-automation-form meal-default-settings">
    <p class="form-hint">${mealText('meals.planDefaultSettingsHint', 'These household defaults are used when a Meal Plan does not provide a more specific value.')}</p>
    <section>
      <h3>${mealText('meals.chooserFailsafe', 'Chooser failsafe')}</h3>
      <p class="form-hint">${mealText('meals.chooserFailsafeHint', 'After a primary chooser and every fixed backup decline or become unavailable, use this final safety net.')}</p>
      <label class="label"><span>${mealText('meals.finalFailsafe', 'Final failsafe')}</span><select class="form-input" name="chooser_terminal_strategy"><option value="personal_choice" ${terminalStrategy === 'personal_choice' ? 'selected' : ''}>${mealText('meals.policyPersonalChoice', 'Personal Choice')}</option><option value="eligible_round_robin" ${terminalStrategy === 'eligible_round_robin' ? 'selected' : ''}>${mealText('meals.eligibleRoundRobin', 'Eligible round robin')}</option><option value="fixed" ${terminalStrategy === 'fixed' ? 'selected' : ''}>${mealText('meals.fixedLastResort', 'Fixed last-resort person')}</option></select></label>
      <label class="label" data-terminal-fixed ${terminalStrategy === 'fixed' ? '' : 'hidden'}><span>${mealText('meals.lastResortPerson', 'Last-resort person')}</span><select class="form-input" name="chooser_terminal_user_id">${planMemberOptions(defaults.chooser_terminal_user_id)}</select><small class="form-hint">${mealText('meals.lastResortPersonHint', 'This person is prompted only after every normal option is exhausted, even if they previously skipped.')}</small></label>
      <details class="meal-plan-rule__participants" data-terminal-rotation ${terminalStrategy === 'eligible_round_robin' ? 'open' : 'hidden'}><summary><span><strong>${mealText('meals.eligibleRotationOverride', 'Eligible rotation override')}</strong><small>${mealText('meals.eligibleRotationOverrideHint', 'Leave everyone unchecked to use all eligible household members.')}</small></span><i data-lucide="chevron-down" class="icon-sm" aria-hidden="true"></i></summary><div class="meal-plan-rule__participants-body"><div data-plan-participant-list>${members.map((member) => `<label class="meal-inline-choice"><input type="checkbox" name="chooser_round_robin_user_id" value="${member.id}" ${terminalRotation.has(Number(member.id)) ? 'checked' : ''}><span>${esc(member.display_name || member.name)}</span></label>`).join('')}</div></div></details>
    </section>
    <section>
      <h3>${mealText('meals.groceryPreparation', 'Grocery preparation')}</h3>
      ${noLists ? `<div class="meal-settings-empty"><i data-lucide="shopping-basket" class="icon-sm" aria-hidden="true"></i><span><strong>${mealText('meals.noShoppingListsYet', 'No Shopping lists yet')}</strong><small>${mealText('meals.createListHereHint', 'Create the first list here, then Yuvomi can prepare grocery drafts for it.')}</small></span></div>` : ''}
      <label class="meal-automation__toggle"><input type="checkbox" name="grocery_enabled" ${grocery.enabled !== false && grocery.enabled !== 0 ? 'checked' : ''}><span><strong>${mealText('meals.enableGroceryPreparation', 'Enable grocery preparation')}</strong></span></label>
      <label class="label"><span>${esc(t('meals.defaultShoppingList'))}</span><select class="form-input" name="default_shopping_list_id"><option value="">${noLists ? mealText('meals.noShoppingListsYet', 'No Shopping lists yet') : esc(t('meals.noDefaultShoppingList'))}</option>${listOptions}<option value="__create__">${mealText('meals.createNewShoppingList', '+ Create a new Shopping list…')}</option></select></label>
      <label class="label" data-new-shopping-list hidden><span>${mealText('meals.newShoppingListName', 'New list name')}</span><input class="form-input" name="new_shopping_list_name" maxlength="120" placeholder="${mealText('meals.shoppingListNamePlaceholder', 'e.g. Weekly groceries')}"></label>
      <label class="meal-automation__toggle"><input type="checkbox" name="auto_create_grocery_draft" ${grocery.auto_create_grocery_draft !== false && grocery.auto_create_grocery_draft !== 0 ? 'checked' : ''}><span>${esc(t('meals.autoCreateGroceryDraft'))}</span></label>
      <label class="meal-automation__toggle"><input type="checkbox" name="auto_finalize_grocery" ${grocery.auto_finalize_grocery ? 'checked' : ''}><span>${esc(t('meals.autoFinalizeGrocery'))}<small>${esc(t('meals.autoFinalizeGroceryHint'))}</small></span></label>
      <div class="meal-automation__timing"><label class="label"><span>${mealText('meals.groceryLeadMinutes', 'Prepare grocery draft before meals (minutes)')}</span><input class="form-input" type="number" min="0" max="10080" name="grocery_lead_minutes" value="${Number(grocery.grocery_lead_minutes ?? 1440)}"></label><label class="label"><span>${mealText('meals.groceryAggregation', 'Group grocery items by')}</span><select class="form-input" name="aggregation_mode"><option value="ingredient" ${grocery.aggregation_mode === 'ingredient' || !grocery.aggregation_mode ? 'selected' : ''}>${mealText('meals.aggregateIngredient', 'Ingredient')}</option><option value="meal" ${grocery.aggregation_mode === 'meal' ? 'selected' : ''}>${mealText('meals.aggregateMeal', 'Meal')}</option><option value="recipe" ${grocery.aggregation_mode === 'recipe' ? 'selected' : ''}>${mealText('meals.aggregateRecipe', 'Recipe')}</option></select></label></div>
    </section>
    <section>
      <h3>${esc(t('meals.executionTaskRoles'))}</h3>
      <label class="meal-automation__master"><input type="checkbox" name="enabled" ${execution.enabled ? 'checked' : ''}><span><strong>${esc(t('meals.enableAutomation'))}</strong><small>${esc(t('meals.enableAutomationHint'))}</small></span></label>
      <p class="form-hint">${mealText('meals.executionDefaultsHint', 'These defaults create practical household Tasks when a week is prepared; an individual Meal Plan slot can choose different assignments.')}</p>
      <div class="meal-automation__roles">${roleToggle('preparation', 'meals.rolePreparation')}${roleToggle('cooking', 'meals.roleCooking')}${roleToggle('supervision', 'meals.roleSupervision')}${roleToggle('serving', 'meals.roleServing')}${roleToggle('cleanup', 'meals.roleCleanup')}</div>
      <div class="meal-automation__timing"><label>${esc(t('meals.preparationLead'))}<input class="form-input" type="number" min="0" max="1440" name="preparation_lead_minutes" value="${Number(execution.preparation_lead_minutes ?? 60)}"></label><label>${esc(t('meals.cookingLead'))}<input class="form-input" type="number" min="0" max="1440" name="cooking_lead_minutes" value="${Number(execution.cooking_lead_minutes ?? 30)}"></label><label>${esc(t('meals.cleanupDelay'))}<input class="form-input" type="number" min="0" max="1440" name="cleanup_delay_minutes" value="${Number(execution.cleanup_delay_minutes ?? 30)}"></label></div>
    </section>
    <div class="modal-panel__footer modal-panel__footer--plain"><button type="button" class="btn btn--secondary" data-modal-close>${esc(t('common.cancel'))}</button><button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button></div>
  </form>`;
  openSharedModal({ title: mealText('meals.planDefaultSettings', 'Meal Plan Default Settings'), content, size: 'lg', onSave(panel) {
    const strategy = panel.querySelector('[name="chooser_terminal_strategy"]');
    const fixed = panel.querySelector('[data-terminal-fixed]');
    const rotation = panel.querySelector('[data-terminal-rotation]');
    const syncTerminal = () => {
      fixed.hidden = strategy.value !== 'fixed';
      rotation.hidden = strategy.value !== 'eligible_round_robin';
    };
    strategy.addEventListener('change', syncTerminal);
    syncTerminal();
    const listSelect = panel.querySelector('[name="default_shopping_list_id"]');
    const newList = panel.querySelector('[data-new-shopping-list]');
    const syncList = () => { newList.hidden = listSelect.value !== '__create__'; };
    listSelect.addEventListener('change', syncList);
    syncList();
    panel.querySelector('[data-modal-close]')?.addEventListener('click', () => closeSharedModal({ force: true }));
    panel.querySelector('#meal-default-settings-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        let shoppingListId = Number(data.get('default_shopping_list_id')) || null;
        if (data.get('default_shopping_list_id') === '__create__') {
          const name = String(data.get('new_shopping_list_name') || '').trim();
          if (!name) {
            reportFieldError(form.querySelector('[name="new_shopping_list_name"]'), t('common.nameRequired'));
            submit.disabled = false;
            return;
          }
          const created = await api.post('/shopping', { name });
          const list = created?.data ?? created;
          shoppingListId = Number(list.id);
          state.lists.push(list);
        }
        const terminal = data.get('chooser_terminal_strategy');
        if (terminal === 'fixed' && !Number(data.get('chooser_terminal_user_id'))) {
          reportFieldError(form.querySelector('[name="chooser_terminal_user_id"]'), mealText('meals.chooseLastResortPerson', 'Choose the fixed last-resort person.'));
          submit.disabled = false;
          return;
        }
        const commonGrocery = {
          default_shopping_list_id: shoppingListId,
          auto_create_grocery_draft: data.has('auto_create_grocery_draft'),
          auto_finalize_grocery: data.has('auto_finalize_grocery'),
        };
        const [executionResponse, groceryResponse] = await Promise.all([
          api.put('/meals/execution-settings', {
            enabled: data.has('enabled'), ...commonGrocery,
            generate_preparation: data.has('generate_preparation'), generate_cooking: data.has('generate_cooking'), generate_supervision: data.has('generate_supervision'), generate_serving: data.has('generate_serving'), generate_cleanup: data.has('generate_cleanup'),
            preparation_lead_minutes: Number(data.get('preparation_lead_minutes')), cooking_lead_minutes: Number(data.get('cooking_lead_minutes')), cleanup_delay_minutes: Number(data.get('cleanup_delay_minutes')),
          }),
          api.put('/meals/grocery-settings', {
            enabled: data.has('grocery_enabled'), ...commonGrocery,
            grocery_lead_minutes: Number(data.get('grocery_lead_minutes') || 0), aggregation_mode: data.get('aggregation_mode'),
          }),
          api.put('/meals/plan-defaults', {
            chooser_terminal_strategy: terminal,
            chooser_terminal_user_id: terminal === 'fixed' ? Number(data.get('chooser_terminal_user_id')) : null,
            chooser_round_robin_user_ids: data.getAll('chooser_round_robin_user_id').map(Number),
          }),
        ]);
        state.planning.execution_settings = executionResponse?.data ?? executionResponse;
        state.grocerySettings = groceryResponse?.data ?? groceryResponse;
        closeSharedModal({ force: true });
        await openMealPlanManager();
        window.yuvomi?.showToast(mealText('meals.planDefaultsSaved', 'Meal Plan defaults saved.'), 'success');
      } catch (error) {
        window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
        submit.disabled = false;
      }
    });
    if (window.lucide) lucide.createIcons({ el: panel });
  }});
}

function openMealAutomationModal() {
  const settings = state.planning.execution_settings || {};
  const listOptions = state.lists.map((list) => `<option value="${list.id}" ${Number(settings.default_shopping_list_id) === Number(list.id) ? 'selected' : ''}>${esc(list.name)}</option>`).join('');
  const roleToggle = (key, labelKey) => `<label class="meal-automation__toggle"><input type="checkbox" name="generate_${key}" ${settings[`generate_${key}`] !== 0 ? 'checked' : ''}><span>${esc(t(labelKey))}</span></label>`;
  const content = `<form id="meal-automation-form" class="meal-automation-form">
    <p class="form-hint">${esc(t('meals.automationDescription'))}</p>
    <label class="meal-automation__master"><input type="checkbox" name="enabled" ${settings.enabled ? 'checked' : ''}><span><strong>${esc(t('meals.enableAutomation'))}</strong><small>${esc(t('meals.enableAutomationHint'))}</small></span></label>
    <section>
      <h3>${esc(t('meals.groceryAutomation'))}</h3>
      <label class="form-label">${esc(t('meals.defaultShoppingList'))}<select class="form-input" name="default_shopping_list_id"><option value="">${esc(t('meals.noDefaultShoppingList'))}</option>${listOptions}</select></label>
      <label class="meal-automation__toggle"><input type="checkbox" name="auto_create_grocery_draft" ${settings.auto_create_grocery_draft !== 0 ? 'checked' : ''}><span>${esc(t('meals.autoCreateGroceryDraft'))}</span></label>
      <label class="meal-automation__toggle"><input type="checkbox" name="auto_finalize_grocery" ${settings.auto_finalize_grocery ? 'checked' : ''}><span>${esc(t('meals.autoFinalizeGrocery'))}<small>${esc(t('meals.autoFinalizeGroceryHint'))}</small></span></label>
    </section>
    <section>
      <h3>${esc(t('meals.executionTaskRoles'))}</h3>
      <div class="meal-automation__roles">
        ${roleToggle('preparation', 'meals.rolePreparation')}
        ${roleToggle('cooking', 'meals.roleCooking')}
        ${roleToggle('supervision', 'meals.roleSupervision')}
        ${roleToggle('serving', 'meals.roleServing')}
        ${roleToggle('cleanup', 'meals.roleCleanup')}
      </div>
      <div class="meal-automation__timing">
        <label>${esc(t('meals.preparationLead'))}<input class="form-input" type="number" min="0" max="1440" name="preparation_lead_minutes" value="${Number(settings.preparation_lead_minutes ?? 60)}"></label>
        <label>${esc(t('meals.cookingLead'))}<input class="form-input" type="number" min="0" max="1440" name="cooking_lead_minutes" value="${Number(settings.cooking_lead_minutes ?? 30)}"></label>
        <label>${esc(t('meals.cleanupDelay'))}<input class="form-input" type="number" min="0" max="1440" name="cleanup_delay_minutes" value="${Number(settings.cleanup_delay_minutes ?? 30)}"></label>
      </div>
    </section>
    <div class="modal-panel__footer modal-panel__footer--plain">
      <button type="button" class="btn btn--secondary" data-modal-close>${esc(t('common.cancel'))}</button>
      <button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button>
    </div>
  </form>`;
  openSharedModal({ title: t('meals.automationTitle'), content, size: 'lg', onSave(panel) {
    panel.querySelector('[data-modal-close]')?.addEventListener('click', () => closeSharedModal({ force: true }));
    panel.querySelector('#meal-automation-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = panel.querySelector('[type="submit"]');
      if (submit) submit.disabled = true;
      const data = new FormData(form);
      const payload = {
        enabled: data.has('enabled'),
        default_shopping_list_id: Number(data.get('default_shopping_list_id')) || null,
        auto_create_grocery_draft: data.has('auto_create_grocery_draft'),
        auto_finalize_grocery: data.has('auto_finalize_grocery'),
        generate_preparation: data.has('generate_preparation'),
        generate_cooking: data.has('generate_cooking'),
        generate_supervision: data.has('generate_supervision'),
        generate_serving: data.has('generate_serving'),
        generate_cleanup: data.has('generate_cleanup'),
        preparation_lead_minutes: Number(data.get('preparation_lead_minutes')),
        cooking_lead_minutes: Number(data.get('cooking_lead_minutes')),
        cleanup_delay_minutes: Number(data.get('cleanup_delay_minutes')),
      };
      try {
        const response = await api.put('/meals/execution-settings', payload);
        state.planning.execution_settings = response.data;
        closeSharedModal({ force: true });
        await openMealPlanManager();
        window.yuvomi?.showToast(t('meals.automationSavedToast'), 'success');
      } catch (error) {
        window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
        if (submit) submit.disabled = false;
      }
    });
  }});
}

function openMealScheduleModal() {
  const timingByType = new Map((state.planning.timing_defaults || []).map((row) => [row.meal_type, row]));
  const slotByKey = new Map((state.planning.slots || []).map((row) => [`${row.weekday}:${row.meal_type}`, row]));
  const members = state.planning.members || [];
  const places = state.planning.places || [];
  const memberOptions = (selected) => `<option value="">Choose a member</option>${members.map((member) => `<option value="${member.id}" ${Number(selected) === Number(member.id) ? 'selected' : ''}>${esc(member.display_name)}</option>`).join('')}`;
  const placeOptions = (selected) => `<option value="">No specific Place</option>${places.map((place) => `<option value="${place.id}" ${Number(selected) === Number(place.id) ? 'selected' : ''} ${!place.active && Number(selected) !== Number(place.id) ? 'disabled' : ''}>${esc(place.name)}${place.active ? '' : ' (inactive)'}</option>`).join('')}`;
  const timingRows = MEAL_TYPES().map((type) => {
    const timing = timingByType.get(type.key) || {};
    return `<div class="meal-timing-row" data-timing-type="${type.key}">
      <strong>${type.label}</strong>
      <label>Earliest<input class="form-input" type="time" data-timing-earliest value="${esc(timing.earliest_time || '')}"></label>
      <label>Preferred<input class="form-input" type="time" data-timing-preferred value="${esc(timing.preferred_time || '')}"></label>
      <label>Latest<input class="form-input" type="time" data-timing-latest value="${esc(timing.latest_time || '')}"></label>
      <label>Minutes<input class="form-input" type="number" min="1" max="720" data-timing-duration value="${timing.expected_duration_minutes || 30}"></label>
    </div>`;
  }).join('');
  const scheduleCells = Array.from({ length: 7 }, (_, weekday) => {
    return `<section class="meal-schedule-day"><h3>${DAY_NAMES()[weekday]}</h3><div class="meal-schedule-day__slots">${MEAL_TYPES().map((type) => {
      const slot = slotByKey.get(`${weekday}:${type.key}`) || {};
      const selectedParticipants = new Set((slot.participant_ids || []).map(Number));
      return `<details class="meal-schedule-cell" data-schedule-weekday="${weekday}" data-schedule-type="${type.key}" ${slot.active ? 'open' : ''}>
        <summary><label><input type="checkbox" data-schedule-active ${slot.active ? 'checked' : ''}> <strong>${type.label}</strong></label><span>${slot.active ? 'Scheduled' : 'Off'}</span></summary>
        <div class="meal-schedule-cell__fields">
          <label>Selection policy<select class="form-input" data-schedule-policy>
            <option value="fixed" ${slot.policy === 'fixed' || !slot.policy ? 'selected' : ''}>Fixed chooser</option>
            <option value="round_robin" ${slot.policy === 'round_robin' ? 'selected' : ''}>Rotate choosers</option>
            <option value="personal_choice" ${slot.policy === 'personal_choice' ? 'selected' : ''}>Each person chooses</option>
          </select></label>
          <label data-fixed-chooser>Chooser<select class="form-input" data-schedule-fixed>${memberOptions(slot.fixed_user_id)}</select></label>
          <fieldset><legend>Participants</legend>${members.map((member) => `<label class="meal-schedule-person"><input type="checkbox" data-schedule-participant value="${member.id}" ${selectedParticipants.has(Number(member.id)) ? 'checked' : ''}> ${esc(member.display_name)}</label>`).join('') || '<small>No household members found.</small>'}</fieldset>
          <label>Fallback chooser<select class="form-input" data-schedule-fallback>${memberOptions(slot.fallback_user_id)}</select></label>
          <label>Cook<select class="form-input" data-schedule-cook>${memberOptions(slot.cook_user_id)}</select></label>
          <label>Supervisor<select class="form-input" data-schedule-supervisor>${memberOptions(slot.supervisor_user_id)}</select></label>
          <label>Choice due before meal (minutes)<input class="form-input" type="number" min="0" max="10080" data-schedule-deadline value="${Number(slot.selection_deadline_minutes ?? 1440)}"></label>
          <label>Reminder before deadline (minutes)<input class="form-input" type="number" min="0" max="10080" data-schedule-reminder value="${Number(slot.reminder_minutes ?? 120)}"></label>
          <label data-snack-limit ${type.key === 'snack' ? '' : 'hidden'}>Personal snack choices<input class="form-input" type="number" min="1" max="20" data-schedule-snack-limit value="${Number(slot.snack_choice_limit ?? 3)}"></label>
          <label>Meal Place<select class="form-input" data-schedule-place>${placeOptions(slot.place_id)}</select></label>
          <label class="meal-schedule-person"><input type="checkbox" data-schedule-presence ${slot.presence_required ? 'checked' : ''}> Only assign people marked available</label>
        </div>
      </details>`;
    }).join('')}</div></section>`;
  }).join('');

  const content = `<form id="meal-schedule-form">
    <p class="form-hint">Set the household's normal meal windows, then turn on the weekday slots you want Yuvomi to prepare automatically. Generated meals remain editable for that date.</p>
    <h3>Default timing windows</h3><div class="meal-timing-grid">${timingRows}</div>
    <h3>Weekly recurring plan</h3><div class="meal-schedule-grid">${scheduleCells}</div>
    <div class="modal-panel__footer modal-panel__footer--plain"><button type="button" class="btn btn--secondary" data-modal-close>Cancel</button><button type="submit" class="btn btn--primary">Save schedule</button></div>
  </form>`;

  openSharedModal({ title: 'Recurring meal schedule', content, size: 'xl', onSave(panel) {
    const syncCell = (cell) => {
      const policy = cell.querySelector('[data-schedule-policy]').value;
      const fixed = cell.querySelector('[data-fixed-chooser]');
      fixed.hidden = policy !== 'fixed';
      const active = cell.querySelector('[data-schedule-active]').checked;
      cell.querySelector('summary span').textContent = active ? 'Scheduled' : 'Off';
    };
    panel.querySelectorAll('[data-schedule-weekday]').forEach((cell) => {
      syncCell(cell);
      cell.querySelector('[data-schedule-policy]').addEventListener('change', () => syncCell(cell));
      cell.querySelector('[data-schedule-active]').addEventListener('change', () => syncCell(cell));
    });
    panel.querySelector('[data-modal-close]')?.addEventListener('click', closeModal);
    panel.querySelector('#meal-schedule-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector('[type="submit"]');
      submit.disabled = true;
      const timing_defaults = [...panel.querySelectorAll('[data-timing-type]')].map((row) => ({
        meal_type: row.dataset.timingType,
        earliest_time: row.querySelector('[data-timing-earliest]').value || null,
        preferred_time: row.querySelector('[data-timing-preferred]').value || null,
        latest_time: row.querySelector('[data-timing-latest]').value || null,
        expected_duration_minutes: Number(row.querySelector('[data-timing-duration]').value || 30),
      }));
      const slots = [...panel.querySelectorAll('[data-schedule-weekday]')].map((cell) => ({
        weekday: Number(cell.dataset.scheduleWeekday), meal_type: cell.dataset.scheduleType,
        active: cell.querySelector('[data-schedule-active]').checked,
        policy: cell.querySelector('[data-schedule-policy]').value,
        fixed_user_id: Number(cell.querySelector('[data-schedule-fixed]').value) || null,
        fallback_user_id: Number(cell.querySelector('[data-schedule-fallback]').value) || null,
        cook_user_id: Number(cell.querySelector('[data-schedule-cook]').value) || null,
        supervisor_user_id: Number(cell.querySelector('[data-schedule-supervisor]').value) || null,
        selection_deadline_minutes: Number(cell.querySelector('[data-schedule-deadline]').value || 1440),
        reminder_minutes: Number(cell.querySelector('[data-schedule-reminder]').value || 120),
        snack_choice_limit: Number(cell.querySelector('[data-schedule-snack-limit]').value || 3),
        participant_ids: [...cell.querySelectorAll('[data-schedule-participant]:checked')].map((input) => Number(input.value)),
        presence_required: cell.querySelector('[data-schedule-presence]').checked,
        place_id: Number(cell.querySelector('[data-schedule-place]').value) || null,
      }));
      try {
        const response = await api.put('/meals/planning', { timing_defaults, slots });
        state.planning = response.data;
        const materialized = await api.post('/meals/planning/materialize', { week: state.currentWeek });
        await loadWeek(state.currentWeek);
        closeModal({ force: true });
        renderWeekGrid();
        window.yuvomi?.showToast('Recurring meal schedule saved.', 'success');
        if (materialized.data?.execution) openExecutionSummary(materialized.data.execution);
      } catch (error) {
        window.yuvomi?.showToast(error.data?.error || error.message || 'Could not save the schedule.', 'danger');
        submit.disabled = false;
      }
    });
  }});
}

function openMealChoicesModal() {
  const requests = state.selectionRequests;
  const recipeOptions = state.recipes.map((recipe) => `<option value="${recipe.id}">${esc(recipe.title)}</option>`).join('');
  const content = requests.length ? `<div class="meal-choice-list">${requests.map((request) => `
    <section class="meal-choice-card" data-meal-choice="${request.id}" data-choice-limit="${request.policy === 'personal_choice' && request.meal_type === 'snack' ? Number(request.snack_choice_limit || 3) : 1}">
      <div><strong>${esc(request.meal_type)} · ${esc(request.date)}</strong><br><small>${request.reminder_due ? 'Due soon · ' : ''}Choose for ${esc(request.policy === 'personal_choice' ? 'yourself' : 'the household')}${request.responsible_name ? ` · ${esc(request.responsible_name)}` : ''}</small></div>
      <label class="form-label">Recipe (optional)<select class="form-input" data-choice-recipe><option value="">Write a meal name</option>${recipeOptions}</select></label>
      ${request.policy === 'personal_choice' && request.meal_type === 'snack'
        ? `<label class="form-label">Snack choices (one per line, up to ${Number(request.snack_choice_limit || 3)})<textarea class="form-input" data-choice-title rows="3" placeholder="Apple slices\nYogurt"></textarea></label>`
        : '<label class="form-label">Meal name<input class="form-input" data-choice-title maxlength="200" placeholder="What should we eat?"></label>'}
      <label class="form-label">Notes<textarea class="form-input" data-choice-notes rows="2"></textarea></label>
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--ghost" data-choice-decline>Decline</button>
        <button type="button" class="btn btn--primary" data-choice-submit>Choose meal</button>
      </div>
    </section>`).join('')}</div>` : emptyStateHTML({
      icon: 'circle-check-big',
      title: 'You are all caught up',
      description: 'There are no meal choices waiting for you.',
    });
  openSharedModal({ title: 'Meal choices', content, size: 'lg', onSave(panel) {
    panel.querySelectorAll('[data-meal-choice]').forEach((card) => {
      const recipeSelect = card.querySelector('[data-choice-recipe]');
      const titleInput = card.querySelector('[data-choice-title]');
      recipeSelect.addEventListener('change', () => {
        const recipe = state.recipes.find((row) => Number(row.id) === Number(recipeSelect.value));
        if (recipe && !titleInput.value.trim()) titleInput.value = recipe.title;
      });
      card.querySelector('[data-choice-submit]').addEventListener('click', async () => {
        try {
          const titles = titleInput.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
          const notes = card.querySelector('[data-choice-notes]').value;
          const recipeId = Number(recipeSelect.value) || null;
          const payload = Number(card.dataset.choiceLimit) > 1
            ? { action: 'choose', choices: titles.map((title, index) => ({ title, notes, recipe_id: index === 0 ? recipeId : null })) }
            : { action: 'choose', recipe_id: recipeId, title: titles[0] || '', notes };
          await api.post(`/meals/selection-requests/${card.dataset.mealChoice}/respond`, payload);
          await Promise.all([loadSelectionRequests(), loadWeek(state.currentWeek), loadWeekExperience()]);
          closeModal({ force: true });
          renderWeekExperienceHeader();
          renderWeekGrid();
          window.yuvomi?.showToast('Meal choice saved.', 'success');
        } catch (error) { window.yuvomi?.showToast(error.data?.error || error.message, 'danger'); }
      });
      card.querySelector('[data-choice-decline]').addEventListener('click', async () => {
        try {
          await api.post(`/meals/selection-requests/${card.dataset.mealChoice}/respond`, { action: 'decline' });
          await Promise.all([loadSelectionRequests(), loadWeekExperience()]);
          closeModal({ force: true });
          renderWeekExperienceHeader();
          renderWeekGrid();
          window.yuvomi?.showToast('Meal choice declined.', 'success');
        } catch (error) { window.yuvomi?.showToast(error.data?.error || error.message, 'danger'); }
      });
    });
    if (window.lucide) window.lucide.createIcons({ el: panel });
  }});
}

async function changeMealWeek(nextWeek) {
  setWeekBusy();
  state.currentWeek = getMondayOf(nextWeek);
  state.expandedOccurrences.clear();
  state.expandedStatusOptions.clear();
  state.deepLinkOpenKey = null;
  await Promise.all([loadWeek(state.currentWeek), loadWeekExperience()]);
  renderWeekExperienceHeader();
  renderWeekGrid();
  syncMealRouteState({ replace: false });
}

function wireNav() {
  const switchMode = (mode) => {
    state.mode = mode;
    state.viewMode = 'week';
    state.expandedOccurrences.clear();
    state.expandedStatusOptions.clear();
    renderWeekExperienceHeader();
    renderWeekGrid();
    syncMealRouteState({ replace: false });
  };
  _container.querySelector('#meal-view-choices')?.addEventListener('click', () => switchMode('choices'));
  _container.querySelector('#meal-view-status')?.addEventListener('click', () => switchMode('status'));
  _container.querySelector('.meal-primary-tabs')?.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const mode = state.mode === 'choices' ? 'status' : 'choices';
    switchMode(mode);
    _container.querySelector(`#meal-view-${mode}`)?.focus();
  });
  _container.querySelector('#meal-member-select')?.addEventListener('change', async (event) => {
    state.selectedMemberId = Number(event.currentTarget.value) || state.currentUserId;
    state.expandedOccurrences.clear();
    setWeekBusy();
    await loadWeekExperience();
    renderWeekExperienceHeader();
    renderWeekGrid();
    syncMealRouteState({ replace: false });
  });
  _container.querySelector('#meal-context-select')?.addEventListener('change', async (event) => {
    const value = event.currentTarget.value;
    state.selectedContextId = value === 'home' ? 'home' : Number(value) || null;
    state.expandedOccurrences.clear();
    setWeekBusy();
    await loadWeekExperience();
    renderWeekExperienceHeader();
    renderWeekGrid();
    syncMealRouteState({ replace: false });
  });
  _container.querySelector('#meal-view-toggle')?.addEventListener('click', (event) => {
    state.viewMode = state.viewMode === 'week' ? 'timeline' : 'week';
    const button = event.currentTarget;
    button.setAttribute('aria-pressed', String(state.viewMode === 'timeline'));
    button.querySelector('span').textContent = state.viewMode === 'timeline'
      ? mealText('meals.weeklyGrid', 'Weekly grid')
      : mealText('meals.timeline', 'Timeline');
    const icon = button.querySelector('svg, i');
    icon?.remove();
    button.insertAdjacentHTML('afterbegin', `<i data-lucide="${state.viewMode === 'timeline' ? 'layout-grid' : 'list'}" class="icon-sm" aria-hidden="true"></i>`);
    if (window.lucide) lucide.createIcons({ el: button });
    renderWeekGrid();
    syncMealRouteState({ replace: false });
  });
  _container.querySelector('#meal-choice-requests')?.addEventListener('click', openMealChoicesModal);
  _container.querySelector('#meal-plan-manage')?.addEventListener('click', openMealPlanManager);
  _container.querySelector('#meal-prepare-week')?.addEventListener('click', (event) => prepareCurrentWeek(event.currentTarget));
  _container.querySelector('#week-prev')?.addEventListener('click', () => changeMealWeek(addDays(state.currentWeek, -7)));

  _container.querySelector('#week-next')?.addEventListener('click', () => changeMealWeek(addDays(state.currentWeek, 7)));

  _container.querySelector('#week-today')?.addEventListener('click', async () => {
    const monday = getMondayOf(todayKey());
    if (monday === state.currentWeek) return;
    await changeMealWeek(monday);
  });

}

function occurrenceByKey(key) {
  return activeWeekModel().occurrences.find((occurrence) => occurrence.key === key) || null;
}

function occurrenceDialogTitle(occurrence) {
  const slot = occurrence.slot_label || mealTypeLabel(occurrence.meal_type);
  const title = state.mode === 'choices'
    ? decisionFoodSummary(occurrence, decisionForMember(occurrence, state.selectedMemberId)).title
    : occurrenceMealTitle(occurrence);
  return title ? `${slot}: ${title}` : slot;
}

async function repairOccurrenceChooser(occurrence, button, panel = null) {
  const mealId = Number(occurrence?.meal?.id || occurrence?.id);
  if (!mealId || !state.isAdmin) return false;
  if (button) button.disabled = true;
  try {
    const response = await api.post(`/meals/${mealId}/chooser/repair`, {});
    await Promise.all([loadSelectionRequests(), loadWeek(state.currentWeek), loadWeekExperience()]);
    renderWeekExperienceHeader();
    renderWeekGrid();
    if (panel) refreshOccurrenceDialog(panel, occurrence.key);
    const result = response?.data ?? response ?? {};
    window.yuvomi?.showToast(
      result.guidance || result.message || mealText('meals.chooserRepaired', 'The next chooser is ready.'),
      'success',
    );
    return true;
  } catch (error) {
    window.yuvomi?.showToast(
      error.data?.error || mealText('meals.chooserRepairFailed', 'A new chooser could not be assigned. Review the Meal Plan defaults.'),
      'danger',
    );
    if (button) button.disabled = false;
    return false;
  }
}

function renderOccurrenceDialogContent(occurrence) {
  const details = state.mode === 'status'
    ? renderStatusOccurrenceDetails(occurrence)
    : renderChoiceOccurrenceDetails(occurrence, activeWeekModel(), { includeActingNotice: true });
  return `<div class="meal-occurrence-dialog" data-meal-occurrence-dialog="${esc(occurrence.key)}">
    <div class="meal-choice-card__details meal-occurrence-dialog__details">${details}</div>
  </div>`;
}

function refreshOccurrenceDialog(panel, key, focusSelector = null) {
  if (!panel?.isConnected || state.desktopOccurrenceDialogKey !== key) return;
  const occurrence = occurrenceByKey(key);
  if (!occurrence) {
    closeSharedModal({ force: true });
    return;
  }
  const body = panel.querySelector('.modal-panel__body');
  if (!body) return;
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', renderOccurrenceDialogContent(occurrence));
  const title = panel.querySelector('#shared-modal-title');
  if (title) title.textContent = occurrenceDialogTitle(occurrence);
  if (window.lucide) lucide.createIcons({ el: body });
  refreshDirtySnapshot();
  if (focusSelector) requestAnimationFrame(() => body.querySelector(focusSelector)?.focus());
}

function openOccurrenceDialog(key) {
  const occurrence = occurrenceByKey(key);
  if (!occurrence) return;
  state.desktopOccurrenceDialogKey = key;
  state.expandedOccurrences.add(key);
  state.deepLinkOpenKey = key;
  syncMealRouteState();
  openSharedModal({
    title: occurrenceDialogTitle(occurrence),
    content: renderOccurrenceDialogContent(occurrence),
    size: 'lg',
    initialFocus: 'none',
    onClose() {
      if (state.desktopOccurrenceDialogKey !== key) return;
      state.desktopOccurrenceDialogKey = null;
      state.expandedOccurrences.delete(key);
      if (state.deepLinkOpenKey === key) state.deepLinkOpenKey = null;
      syncMealRouteState();
      renderWeekGrid();
    },
    onSave(panel) {
      wireOccurrenceDialog(panel, key);
    },
  });
}

async function persistMealDecision(occurrence, payload, submitter) {
  const mealId = Number(occurrence?.meal?.id || occurrence?.id);
  if (!mealId) return;
  if (submitter) submitter.disabled = true;
  try {
    await api.post(`/meals/${mealId}/decisions`, payload);
    await Promise.all([loadWeek(state.currentWeek), loadWeekExperience()]);
    renderWeekExperienceHeader();
    renderWeekGrid();
    window.yuvomi?.showToast(mealText('meals.choiceSaved', 'Meal choices saved.'), 'success');
    return true;
  } catch (error) {
    window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
    if (submitter) submitter.disabled = false;
    return false;
  }
}

async function submitMealDecisionForm(form) {
  const occurrence = occurrenceByKey(form.dataset.occurrenceKey);
  if (!occurrence || !canActForSelectedMember()) return false;
  const data = new FormData(form);
  const participating = data.get('participation') !== 'not_participating';
  const entree = data.get('meal_choice');
  const backup = entree === 'backup';
  const backupMealTitle = String(data.get('backup_meal_title') || '').trim();
  const backupRecipe = state.recipes.find((recipe) => recipe.title.localeCompare(backupMealTitle, undefined, { sensitivity: 'base' }) === 0)
    || state.recipes.find((recipe) => Number(recipe.id) === Number(data.get('backup_recipe_id')));
  const backupRecipeId = backupRecipe?.id || null;
  const personalMealTitle = String(data.get('selected_meal_title') || '').trim();
  const personalRecipe = state.recipes.find((recipe) => recipe.title.localeCompare(personalMealTitle, undefined, { sensitivity: 'base' }) === 0)
    || state.recipes.find((recipe) => Number(recipe.id) === Number(data.get('selected_recipe_id')));
  if (participating && backup && !backupMealTitle) {
    reportFieldError(form.querySelector('[name="backup_meal_title"]'), t('common.nameRequired'));
    return false;
  }
  const menuItemIds = [
    ...(entree && !['personal', 'backup', 'household'].includes(entree) ? [Number(entree)] : []),
    ...data.getAll('menu_side').map(Number),
  ].filter(Number.isFinite);
  const payload = mealDecisionPayload({
    occurrence,
    memberId: state.selectedMemberId,
    participating,
    choice: !participating ? 'skip' : entree === 'personal' ? data.get('personal_choice_kind') || 'personal' : backup ? 'backup' : 'assigned',
    menuItemIds: participating ? menuItemIds : [],
    selectedMealTitle: participating && entree === 'personal'
      ? personalMealTitle
      : participating && backup ? backupMealTitle : null,
    selectedRecipeId: participating && entree === 'personal'
      ? personalRecipe?.id || null
      : participating && backup ? backupRecipeId : null,
    notes: data.get('notes'),
    deviceKey: stableMealDeviceKey(),
  });
  payload.confirmed = true;
  return persistMealDecision(occurrence, payload, form.querySelector('[type="submit"]'));
}

function handleMealDecisionControlChange(event) {
  const decisionForm = event.target.closest('[data-meal-decision]');
  if (decisionForm && (event.target.name === 'participation' || event.target.name === 'meal_choice')) {
    const participating = decisionForm.querySelector('[name="participation"]:checked')?.value !== 'not_participating';
    const personalChoice = decisionForm.querySelector('[name="meal_choice"]:checked')
      || decisionForm.querySelector('[name="meal_choice"][type="hidden"]');
    const personal = personalChoice?.value === 'personal';
    const backup = personalChoice?.value === 'backup';
    const foodSection = decisionForm.querySelector('[data-meal-food-section]');
    if (foodSection) foodSection.disabled = !participating;
    const notes = decisionForm.querySelector('[data-meal-notes]');
    if (notes) notes.disabled = !participating;
    decisionForm.querySelectorAll('[data-personal-choice-fields] input, [data-personal-choice-fields] select')
      .forEach((field) => { field.disabled = !participating || !personal; });
    decisionForm.querySelectorAll('[data-backup-choice-fields] input, [data-backup-choice-fields] select')
      .forEach((field) => { field.disabled = !participating || !backup; });
    return true;
  }
  if (event.target.matches('[data-personal-recipe]')) {
    const form = event.target.closest('[data-meal-decision]');
    const title = form?.querySelector('[name="selected_meal_title"]');
    const recipe = state.recipes.find((row) => Number(row.id) === Number(event.target.value));
    if (title && recipe && !title.value.trim()) title.value = recipe.title;
    return true;
  }
  if (event.target.matches('[data-backup-recipe]')) {
    const form = event.target.closest('[data-meal-decision]');
    const title = form?.querySelector('[name="backup_meal_title"]');
    const recipe = state.recipes.find((row) => Number(row.id) === Number(event.target.value));
    if (title && recipe && !title.value.trim()) title.value = recipe.title;
    return true;
  }
  if (!event.target.matches('[data-menu-side]') || !event.target.checked) return false;
  const form = event.target.closest('[data-meal-decision]');
  const checked = [...form.querySelectorAll('[data-menu-side]:checked')];
  const sideLimit = Math.min(9, Math.max(0, Number(form.dataset.maxSideChoices ?? 3)));
  if (checked.length <= sideLimit) return true;
  event.target.checked = false;
  window.yuvomi?.showToast(`${mealText('meals.maxSides', 'Maximum sides')}: ${sideLimit}`, 'warning');
  return true;
}

function wireOccurrenceDialog(panel, key) {
  panel.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-meal-decision]');
    if (!form) return;
    event.preventDefault();
    if (await submitMealDecisionForm(form)) refreshOccurrenceDialog(panel, key, '[type="submit"]');
  });
  panel.addEventListener('change', handleMealDecisionControlChange);
  panel.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'toggle-status-option') {
      const optionKey = button.dataset.optionKey;
      if (state.expandedStatusOptions.has(optionKey)) state.expandedStatusOptions.delete(optionKey);
      else state.expandedStatusOptions.add(optionKey);
      refreshOccurrenceDialog(panel, key, '[data-action="toggle-status-option"]');
      return;
    }
    if (action === 'skip-meal-decision') {
      const occurrence = occurrenceByKey(button.dataset.occurrenceKey);
      if (!occurrence || !canActForSelectedMember()) return;
      const notes = button.closest('form')?.querySelector('[name="notes"]')?.value || '';
      const payload = mealDecisionPayload({
        occurrence,
        memberId: state.selectedMemberId,
        participating: false,
        choice: 'skip',
        menuItemIds: [],
        notes,
        deviceKey: stableMealDeviceKey(),
      });
      payload.confirmed = true;
      if (await persistMealDecision(occurrence, payload, button)) refreshOccurrenceDialog(panel, key);
      return;
    }
    if (action === 'decline-meal-choice') {
      button.disabled = true;
      try {
        await api.post(`/meals/selection-requests/${Number(button.dataset.obligationId)}/respond`, { action: 'decline' });
        await Promise.all([loadSelectionRequests(), loadWeek(state.currentWeek), loadWeekExperience()]);
        renderWeekExperienceHeader();
        renderWeekGrid();
        refreshOccurrenceDialog(panel, key);
        window.yuvomi?.showToast(mealText('meals.choiceDeclined', 'Meal choice responsibility declined.'), 'success');
      } catch (error) {
        window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
        button.disabled = false;
      }
      return;
    }
    if (action === 'repair-meal-chooser') {
      const occurrence = occurrenceByKey(button.dataset.occurrenceKey) || occurrenceByKey(key);
      if (occurrence) await repairOccurrenceChooser(occurrence, button, panel);
      return;
    }
    if (action === 'edit-meal-menu') {
      const occurrence = occurrenceByKey(button.dataset.occurrenceKey);
      if (occurrence && canEditOccurrenceMenu(occurrence)) {
        await closeSharedModal({ force: true });
        openMealMenuEditor(occurrence);
      }
      return;
    }
    if (action === 'open-recipe') return;
    if (action === 'edit-meal') {
      const meal = state.meals.find((item) => Number(item.id) === Number(button.dataset.mealId));
      if (meal) {
        await closeSharedModal({ force: true });
        openMealModal({ mode: 'edit', meal, date: meal.date, mealType: meal.meal_type });
      }
      return;
    }
    if (action === 'resolve-conflicts') {
      const meal = state.meals.find((item) => Number(item.id) === Number(button.dataset.mealId));
      if (meal) {
        await closeSharedModal({ force: true });
        openConflictModal(meal);
      }
      return;
    }
    if (action === 'meal-execution') {
      button.disabled = true;
      try {
        const response = await api.post(`/meals/${Number(button.dataset.mealId)}/execution-tasks`, {});
        await loadWeek(state.currentWeek);
        renderWeekGrid();
        await closeSharedModal({ force: true });
        openMealExecutionDetail(response.data);
      } catch (error) {
        window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
        button.disabled = false;
      }
      return;
    }
    if (action === 'delete-meal') {
      const mealId = Number(button.dataset.mealId);
      await closeSharedModal({ force: true });
      await deleteMeal(mealId);
      return;
    }
    if (action === 'transfer-meal') {
      const mealId = Number(button.dataset.mealId);
      await closeSharedModal({ force: true });
      await transferMeal(mealId, null);
    }
  });
}

function wireGrid(grid) {
  // Delegation am stabilen #week-grid nur EINMAL binden. renderWeekGrid läuft bei
  // jedem Wochenwechsel erneut, ersetzt aber nur die Kinder (replaceChildren) —
  // ohne Guard akkumulierten click/keydown/pointerdown-Listener und feuerten
  // add-/delete-/transfer-meal mehrfach (Muster wie shopping.js#wireListContentEvents).
  if (grid.dataset.eventsWired) return;
  grid.dataset.eventsWired = 'true';

  grid.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;

    if (action === 'toggle-occurrence') {
      const key = btn.dataset.occurrenceKey;
      if (usesDesktopOccurrenceDialog()) {
        openOccurrenceDialog(key);
        return;
      }
      if (state.expandedOccurrences.has(key)) {
        state.expandedOccurrences.delete(key);
        if (state.deepLinkOpenKey === key) state.deepLinkOpenKey = null;
      } else {
        state.expandedOccurrences.add(key);
        state.deepLinkOpenKey = key;
      }
      renderWeekGrid();
      syncMealRouteState();
      requestAnimationFrame(() => [..._container.querySelectorAll('[data-action="toggle-occurrence"]')]
        .find((node) => node.dataset.occurrenceKey === key)?.focus());
      return;
    }

    if (action === 'toggle-status-option') {
      const key = btn.dataset.optionKey;
      if (state.expandedStatusOptions.has(key)) state.expandedStatusOptions.delete(key);
      else state.expandedStatusOptions.add(key);
      renderWeekGrid();
      requestAnimationFrame(() => [..._container.querySelectorAll('[data-action="toggle-status-option"]')]
        .find((node) => node.dataset.optionKey === key)?.focus());
      return;
    }

    if (action === 'skip-meal-decision') {
      const occurrence = occurrenceByKey(btn.dataset.occurrenceKey);
      if (!occurrence || !canActForSelectedMember()) return;
      const notes = btn.closest('form')?.querySelector('[name="notes"]')?.value || '';
      const payload = mealDecisionPayload({
        occurrence,
        memberId: state.selectedMemberId,
        participating: false,
        choice: 'skip',
        menuItemIds: [],
        notes,
        deviceKey: stableMealDeviceKey(),
      });
      payload.confirmed = true;
      await persistMealDecision(occurrence, payload, btn);
      return;
    }

    if (action === 'decline-meal-choice') {
      btn.disabled = true;
      try {
        await api.post(`/meals/selection-requests/${Number(btn.dataset.obligationId)}/respond`, { action: 'decline' });
        await Promise.all([loadSelectionRequests(), loadWeek(state.currentWeek), loadWeekExperience()]);
        renderWeekExperienceHeader();
        renderWeekGrid();
        window.yuvomi?.showToast(mealText('meals.choiceDeclined', 'Meal choice responsibility declined.'), 'success');
      } catch (error) {
        window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
        btn.disabled = false;
      }
      return;
    }

    if (action === 'repair-meal-chooser') {
      const occurrence = occurrenceByKey(btn.dataset.occurrenceKey);
      if (occurrence) await repairOccurrenceChooser(occurrence, btn);
      return;
    }

    if (action === 'edit-meal-menu') {
      const occurrence = occurrenceByKey(btn.dataset.occurrenceKey);
      if (occurrence && canEditOccurrenceMenu(occurrence)) openMealMenuEditor(occurrence);
      return;
    }

    if (action === 'add-meal') {
      openMealForSelectedContext({ mode: 'create', date: btn.dataset.date, mealType: btn.dataset.type });
      return;
    }

    if (action === 'open-recipe') {
      // Link öffnet sich nativ - nur Bubbling stoppen damit kein Edit-Modal aufgeht
      e.stopPropagation();
      return;
    }

    if (action === 'edit-meal') {
      const mealId = parseInt(btn.dataset.mealId, 10);
      const meal   = state.meals.find((m) => m.id === mealId);
      if (meal) openMealModal({ mode: 'edit', meal, date: meal.date, mealType: meal.meal_type });
      return;
    }
    if (action === 'resolve-conflicts') {
      const meal = state.meals.find((entry) => Number(entry.id) === Number(btn.dataset.mealId));
      if (meal) openConflictModal(meal);
      return;
    }

    if (action === 'meal-execution') {
      btn.disabled = true;
      try {
        const response = await api.post(`/meals/${Number(btn.dataset.mealId)}/execution-tasks`, {});
        await loadWeek(state.currentWeek);
        renderWeekGrid();
        openMealExecutionDetail(response.data);
      } catch (error) {
        window.yuvomi?.showToast(error.data?.error || error.message || t('common.unknownError'), 'danger');
        btn.disabled = false;
      }
      return;
    }

    if (action === 'delete-meal') {
      await deleteMeal(parseInt(btn.dataset.mealId, 10));
      return;
    }

    if (action === 'transfer-meal') {
      await transferMeal(parseInt(btn.dataset.mealId, 10), btn);
    }
  });

  grid.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-meal-decision]');
    if (!form) return;
    event.preventDefault();
    await submitMealDecisionForm(form);
  });

  grid.addEventListener('change', handleMealDecisionControlChange);

  grid.addEventListener('dragover', (e) => {
    if (!_dragRecipeId) return;
    const slot = e.target.closest('.meal-slot, .meal-choice-card');
    if (!slot) return;
    if (!mealMutationContext().allowed || slot.dataset.generatedPlan === 'true') return;
    const recipe = state.recipes.find((entry) => entry.id === _dragRecipeId);
    // Ziehen ist eine Entscheidung des Nutzers, nicht der Automatik: ein Rezept
    // ohne erklärte Mahlzeit bleibt hier ablegbar (#750, recipeAllowsMealType).
    if (!recipe || !recipeAllowsMealType(recipe, slot.dataset.type)) return;
    e.preventDefault();
    clearRecipeDropTargets();
    slot.classList.add('meal-slot--drop-target');
  });

  grid.addEventListener('drop', async (e) => {
    if (!_dragRecipeId) return;
    const slot = e.target.closest('.meal-slot, .meal-choice-card');
    const recipeId = _dragRecipeId;
    _dragRecipeId = null;
    clearRecipeDropTargets();
    if (!slot) return;
    const mutationContext = mealMutationContext();
    if (!mutationContext.allowed) {
      window.yuvomi?.showToast(mealText('meals.chooseContextBeforeEditing', 'Choose Home or a trip before changing this week.'), 'warning');
      return;
    }
    if (slot.dataset.generatedPlan === 'true') {
      window.yuvomi?.showToast(mealText('meals.generatedMealMenuHint', 'Edit this planned occurrence through its menu instead of replacing the Meal Plan output.'), 'warning');
      return;
    }
    const recipe = state.recipes.find((entry) => entry.id === recipeId);
    if (!recipe || !recipeAllowsMealType(recipe, slot.dataset.type)) return;
    e.preventDefault();
    const slotMeals = state.meals.filter((meal) => (
      meal.date === slot.dataset.date
      && meal.meal_type === slot.dataset.type
      && mealMatchesSelectedContext(meal)
      && !meal.parent_meal_id
      && !meal.meal_plan_id
    ));
    if (slotMeals.length) {
      const confirmed = await confirmModal(t('meals.replaceExistingConfirm'), { confirmLabel: t('common.confirm') });
      if (!confirmed) return;
    }
    await addRecipeToSlot(recipe, slot.dataset.date, slot.dataset.type, {
      replaceMeals: slotMeals,
      planningContextId: mutationContext.id,
    });
  });

  wireDragDrop(grid);
}

function wireRecipeSidebar() {
  const sidebar = _container.querySelector('#recipe-sidebar');
  if (!sidebar || sidebar.dataset.eventsWired) return;
  sidebar.dataset.eventsWired = 'true';

  sidebar.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.recipe-sidebar__card');
    if (!card) return;
    if (!mealMutationContext().allowed) {
      e.preventDefault();
      window.yuvomi?.showToast(mealText('meals.chooseContextBeforeEditing', 'Choose Home or a trip before changing this week.'), 'warning');
      return;
    }
    _dragRecipeId = Number(card.dataset.recipeId);
    card.classList.add('recipe-sidebar__card--dragging');
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', card.dataset.recipeId);
  });

  sidebar.addEventListener('dragend', (e) => {
    e.target.closest('.recipe-sidebar__card')?.classList.remove('recipe-sidebar__card--dragging');
    _dragRecipeId = null;
    clearRecipeDropTargets();
  });
}

function clearRecipeDropTargets() {
  _container.querySelectorAll('.meal-slot--drop-target').forEach((slot) => slot.classList.remove('meal-slot--drop-target'));
}

async function addRecipeToSlot(recipe, date, mealType, { replaceMeals = [], planningContextId = null } = {}) {
  try {
    const payload = { ...mealPayloadFromRecipe(recipe, date, mealType), planning_context_id: planningContextId };
    if (replaceMeals.length) {
      const res = await api.post('/meals/apply-plan', { assignments: [payload], replace_existing: true });
      const replacedIds = new Set(replaceMeals.map((meal) => Number(meal.id)));
      state.meals = state.meals.filter((entry) => !replacedIds.has(Number(entry.id)));
      state.meals.push(...(res.data || []));
    } else {
      const res = await api.post('/meals', payload);
      state.meals.push(res.data);
    }
    await loadWeekExperience();
    renderWeekExperienceHeader();
    renderWeekGrid();
  } catch (err) {
    window.yuvomi?.showToast(window.yuvomi?.friendlyError?.(err) ?? t('common.errorGeneric'), 'danger');
  }
}

function openRandomizeModal() {
  const mutationContext = mealMutationContext();
  if (!mutationContext.allowed) {
    window.yuvomi?.showToast(mealText('meals.chooseContextBeforeEditing', 'Choose Home or a trip before changing this week.'), 'warning');
    return;
  }
  openSharedModal({
    title: t('meals.randomizeTitle'),
    size: 'sm',
    content: `
      <div class="meal-randomize-modal">
        <label class="toggle meal-randomize-modal__toggle">
          <input type="checkbox" id="meal-randomize-replace">
          <span class="toggle__track"></span>
          <span>${t('meals.randomizeReplaceExisting')}</span>
        </label>
        <!-- Vorschau statt Blindflug: der Lauf füllt bis zu 28 Slots und kann
             eine ganze geplante Woche überschreiben. Vorher nannte der Dialog
             weder das eine noch das andere (Critique 2026-07-29). -->
        <p class="meal-randomize-modal__preview" id="meal-randomize-preview" aria-live="polite"></p>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" id="meal-randomize-cancel">${t('common.cancel')}</button>
          <button class="btn btn--primary" id="meal-randomize-run">${t('meals.randomizePlan')}</button>
        </div>
      </div>`,
    onSave(panel) {
      const replaceBox = panel.querySelector('#meal-randomize-replace');
      const preview = panel.querySelector('#meal-randomize-preview');
      const runBtn = panel.querySelector('#meal-randomize-run');

      // Rein clientseitig: buildRandomMealAssignments rechnet auf dem bereits
      // geladenen Wochen- und Rezeptbestand, kostet also keinen Roundtrip.
      const updatePreview = () => {
        const plan = buildRandomMealAssignments({
          weekStart: state.currentWeek,
          visibleMealTypes: state.visibleMealTypes,
          meals: state.meals.filter((meal) => mealMatchesSelectedContext(meal) && !meal.parent_meal_id && !meal.meal_plan_id),
          recipes: state.recipes,
          replaceExisting: Boolean(replaceBox?.checked),
        });
        const fill = plan.assignments.length;
        const overwrite = plan.deleteMealIds?.length ?? 0;

        if (!fill) {
          preview.textContent = plan.reason === 'week_full'
            ? t('meals.randomizeWeekFull')
            : t('meals.randomizeNoRecipes');
          runBtn.disabled = true;
          return;
        }
        runBtn.disabled = false;
        preview.textContent = overwrite > 0
          ? `${t('meals.randomizePreview', { count: fill })} ${t('meals.randomizePreviewReplace', { count: overwrite })}`
          : t('meals.randomizePreview', { count: fill });
      };

      replaceBox?.addEventListener('change', updatePreview);
      updatePreview();

      panel.querySelector('#meal-randomize-cancel')?.addEventListener('click', closeModal);
      runBtn?.addEventListener('click', () => runRandomize(panel));
    },
  });
}

async function runRandomize(panel) {
  const mutationContext = mealMutationContext();
  if (!mutationContext.allowed) return;
  const replaceExisting = Boolean(panel.querySelector('#meal-randomize-replace')?.checked);
  const runBtn = panel.querySelector('#meal-randomize-run');
  const plan = buildRandomMealAssignments({
    weekStart: state.currentWeek,
    visibleMealTypes: state.visibleMealTypes,
    meals: state.meals.filter((meal) => mealMatchesSelectedContext(meal) && !meal.parent_meal_id && !meal.meal_plan_id),
    recipes: state.recipes,
    replaceExisting,
  });

  if (!plan.assignments.length) {
    window.yuvomi?.showToast(
      plan.reason === 'week_full' ? t('meals.randomizeWeekFull') : t('meals.randomizeNoRecipes'),
      'info'
    );
    return;
  }

  runBtn.disabled = true;
  try {
    await api.post('/meals/apply-plan', {
      assignments: plan.assignments.map((assignment) => ({
        ...assignment.payload,
        planning_context_id: mutationContext.id,
      })),
      replace_existing: replaceExisting,
      planning_context_id: mutationContext.id,
    });
    await Promise.all([loadWeek(state.currentWeek), loadWeekExperience()]);
    closeModal({ force: true });
    renderWeekExperienceHeader();
    renderWeekGrid();
    window.yuvomi?.showToast(t('meals.randomizeSuccess', { count: plan.assignments.length }), 'success');
  } catch (err) {
    runBtn.disabled = false;
    window.yuvomi?.showToast(window.yuvomi?.friendlyError?.(err) ?? t('common.errorGeneric'), 'danger');
  }
}

// --------------------------------------------------------
// Drag & Drop
// --------------------------------------------------------

let _suppressNextClick = false;

function wireDragDrop(grid) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let dragging = null; // { mealId, sourceDate, sourceType, ghost, startX, startY }

  grid.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.meal-card');
    if (!card) return;
    if (e.target.closest('[data-action="delete-meal"], [data-action="transfer-meal"], [data-action="open-recipe"]')) return;

    const slot = card.closest('.meal-slot');
    if (!slot) return;

    const mealId     = parseInt(card.dataset.mealId, 10);
    const sourceDate = slot.dataset.date;
    const sourceType = slot.dataset.type;

    e.preventDefault();
    card.setPointerCapture(e.pointerId);

    let ghost = null;
    if (!reducedMotion) {
      ghost = card.cloneNode(true);
      ghost.classList.add('meal-card--ghost');
      ghost.style.width  = card.offsetWidth + 'px';
      ghost.style.height = card.offsetHeight + 'px';
      ghost.style.left   = (e.clientX - card.offsetWidth / 2) + 'px';
      ghost.style.top    = (e.clientY - card.offsetHeight / 2) + 'px';
      document.body.appendChild(ghost);
    }

    slot.classList.add('meal-slot--dragging');
    dragging = { mealId, sourceDate, sourceType, ghost, card, slot };

    let lastTarget = null;

    function onMove(ev) {
      if (!dragging) return;
      if (ghost) {
        ghost.style.left = (ev.clientX - ghost.offsetWidth / 2) + 'px';
        ghost.style.top  = (ev.clientY - ghost.offsetHeight / 2) + 'px';
      }
      if (ghost) ghost.style.display = 'none';
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (ghost) ghost.style.display = '';

      const targetSlot = el?.closest('.meal-slot');
      if (targetSlot !== lastTarget) {
        lastTarget?.classList.remove('meal-slot--drop-target');
        if (targetSlot && targetSlot !== dragging.slot) {
          targetSlot.classList.add('meal-slot--drop-target');
        }
        lastTarget = targetSlot;
      }
    }

    async function onUp(ev) {
      if (!dragging) return;
      const { mealId, sourceDate, sourceType, slot: sourceSlot } = dragging;
      cleanup(); // setzt dragging = null - Werte daher vorher destrukturieren

      if (ghost) ghost.style.display = 'none';
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (ghost) ghost.style.display = '';

      const targetSlot = el?.closest('.meal-slot');
      if (targetSlot && targetSlot !== sourceSlot) {
        const targetDate = targetSlot.dataset.date;
        const targetType = targetSlot.dataset.type;
        _suppressNextClick = true;
        setTimeout(() => { _suppressNextClick = false; }, 300);
        await moveMeal(mealId, targetDate, targetType);
      }
    }

    function onCancel() { cleanup(); }

    function cleanup() {
      ghost?.remove();
      dragging?.slot?.classList.remove('meal-slot--dragging');
      lastTarget?.classList.remove('meal-slot--drop-target');
      dragging = null;
      card.removeEventListener('pointermove',   onMove);
      card.removeEventListener('pointerup',     onUp);
      card.removeEventListener('pointercancel', onCancel);
    }

    card.addEventListener('pointermove',   onMove);
    card.addEventListener('pointerup',     onUp);
    card.addEventListener('pointercancel', onCancel);
  });

  // Suppress click after a completed drag
  grid.addEventListener('click', (e) => {
    if (_suppressNextClick) {
      e.stopImmediatePropagation();
      _suppressNextClick = false;
    }
  }, true);
}

async function moveMeal(mealId, targetDate, targetType) {
  try {
    await api.put(`/meals/${mealId}`, { date: targetDate, meal_type: targetType });
    const m = state.meals.find((m) => m.id === mealId);
    if (m) { m.date = targetDate; m.meal_type = targetType; }
    await loadWeekExperience();
    renderWeekExperienceHeader();
    renderWeekGrid();
  } catch {
    renderWeekGrid();
  }
}

// --------------------------------------------------------
// Modal
// --------------------------------------------------------

function openMealModal(opts) {
  state.modal = opts;
  const { mode, date, mealType, meal } = opts;
  const isEdit = mode === 'edit';

  const content = buildModalContent(opts);

  openSharedModal({
    title: isEdit ? t('meals.editMeal') : t('meals.addMealTitle'),
    content,
    size: 'lg',
    onSave(panel) {
      // Autocomplete
      const titleInput = panel.querySelector('#modal-title');
      const acDropdown = panel.querySelector('#modal-autocomplete');
      const recipeInput = panel.querySelector('#modal-recipe-id');
      let acIndex = -1;
      let acTimer;

      const recipeForTitle = (value) => {
        const normalized = String(value || '').trim().toLocaleLowerCase();
        if (!normalized) return null;
        return state.recipes.find((recipe) => (
          String(recipe.title || '').trim().toLocaleLowerCase() === normalized
        )) || null;
      };

      titleInput.addEventListener('input', () => {
        const exactRecipe = recipeForTitle(titleInput.value);
        recipeInput.value = exactRecipe ? String(exactRecipe.id) : '';
        if (exactRecipe && Number(exactRecipe.id) !== Number(currentAppliedRecipe?.id)) {
          applyRecipe(exactRecipe.id);
        } else if (!exactRecipe) {
          currentAppliedRecipe = null;
        }
        clearTimeout(acTimer);
        acTimer = setTimeout(async () => {
          const q = titleInput.value.trim();
          if (!q) { acDropdown.hidden = true; return; }
          try {
            const res = await api.get(`/meals/suggestions?q=${encodeURIComponent(q)}`);
            const recipeMatches = state.recipes
              .filter((recipe) => String(recipe.title || '').toLocaleLowerCase().includes(q.toLocaleLowerCase()))
              .map((recipe) => ({ title: recipe.title, recipe_id: recipe.id }));
            const suggestions = [...recipeMatches, ...(res.data || [])]
              .filter((suggestion, index, all) => suggestion?.title && all.findIndex((candidate) => (
                String(candidate?.title || '').trim().toLocaleLowerCase()
                  === String(suggestion.title).trim().toLocaleLowerCase()
              )) === index);
            if (!suggestions.length) { acDropdown.hidden = true; return; }
            acIndex = -1;
            acDropdown.replaceChildren();
            acDropdown.insertAdjacentHTML('beforeend', suggestions.map((s) => `
              <div class="meal-modal__autocomplete-item" data-title="${esc(s.title)}" data-recipe-id="${Number(s.recipe_id) || ''}">${esc(s.title)}</div>
            `).join(''));
            acDropdown.hidden = false;
          } catch { acDropdown.hidden = true; }
        }, 200);
      });

      titleInput.addEventListener('keydown', (e) => {
        const items = [...acDropdown.querySelectorAll('.meal-modal__autocomplete-item')];
        if (!items.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = Math.min(acIndex + 1, items.length - 1); items.forEach((el, i) => el.classList.toggle('meal-modal__autocomplete-item--active', i === acIndex)); }
        if (e.key === 'ArrowUp')   { e.preventDefault(); acIndex = Math.max(acIndex - 1, 0);                items.forEach((el, i) => el.classList.toggle('meal-modal__autocomplete-item--active', i === acIndex)); }
        if (e.key === 'Enter' && acIndex >= 0) {
          e.preventDefault();
          const item = items[acIndex];
          titleInput.value = item.dataset.title;
          recipeInput.value = item.dataset.recipeId || '';
          if (item.dataset.recipeId) applyRecipe(item.dataset.recipeId);
          acDropdown.hidden = true;
          acIndex = -1;
        }
        if (e.key === 'Escape') acDropdown.hidden = true;
      });

      acDropdown.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.meal-modal__autocomplete-item');
        if (item) {
          titleInput.value = item.dataset.title;
          recipeInput.value = item.dataset.recipeId || '';
          if (item.dataset.recipeId) applyRecipe(item.dataset.recipeId);
          acDropdown.hidden = true;
        }
      });

      // Zutaten
      const ingList   = panel.querySelector('#ingredient-list');
      const addIngBtn = panel.querySelector('#add-ingredient-btn');
      const recipeSelect = recipeInput;
      const recipeScaleInput = panel.querySelector('#modal-recipe-scale');
      const portionsModeSelect = panel.querySelector('#modal-portions-mode');
      const sideList = panel.querySelector('#modal-side-list');
      const addSideBtn = panel.querySelector('#modal-add-side');
      const saveAsRecipeBtn = panel.querySelector('#modal-save-as-recipe');
      let currentAppliedRecipe = state.recipes.find((recipe) => (
        Number(recipe.id) === Number(recipeSelect?.value)
      )) || null;
      let lastAppliedScale = Math.max(Number(recipeScaleInput?.value || 1), 0.1);

      const renderAppliedRecipeIngredients = () => {
        if (!currentAppliedRecipe) return;
        const factor = Math.max(Number(recipeScaleInput?.value || 1), 0.1);
        ingList.replaceChildren();
        ingList.insertAdjacentHTML('beforeend', (currentAppliedRecipe.ingredients || [])
          .map((ing) => ingredientRowHTML({
            name: ing.name,
            quantity: scaleMealIngredientQuantity(ing.quantity ?? '', factor),
            category: ing.category ?? DEFAULT_CATEGORY_NAME,
            categories: mealCategories(),
          }))
          .join(''));
        lastAppliedScale = factor;
        if (window.lucide) lucide.createIcons({ el: ingList });
      };

      // Existing recipe-backed Meals already contain their scaled ingredient
      // snapshot. Scale that visible snapshot proportionally instead of
      // replacing it from the recipe, so any saved or in-dialog custom edits,
      // added rows, and categories survive a serving-count change.
      const rescaleVisibleIngredients = (nextScale) => {
        const normalizedScale = Math.max(Number(nextScale || 1), 0.1);
        if (!currentAppliedRecipe || !Number.isFinite(normalizedScale)) return;
        const rows = [...ingList.querySelectorAll('.ingredient-row')];
        if (!rows.length) {
          renderAppliedRecipeIngredients();
          return;
        }
        const factor = normalizedScale / Math.max(lastAppliedScale, 0.1);
        for (const row of rows) {
          const quantityInput = row.querySelector('.ingredient-row__qty');
          if (quantityInput) {
            quantityInput.value = scaleMealIngredientQuantity(quantityInput.value, factor) ?? '';
          }
        }
        lastAppliedScale = normalizedScale;
      };

      const applyRecipe = (recipeId) => {
        const id = Number(recipeId);
        if (!id) {
          currentAppliedRecipe = null;
          lastAppliedScale = Math.max(Number(recipeScaleInput?.value || 1), 0.1);
          return;
        }
        const recipe = state.recipes.find((r) => r.id === id);
        if (!recipe) return;

        currentAppliedRecipe = recipe;
        recipeSelect.value = String(recipe.id);
        panel.querySelector('#modal-title').value = recipe.title || '';
        panel.querySelector('#modal-notes').value = recipe.notes || '';
        panel.querySelector('#modal-recipe-url').value = recipe.recipe_url || '';
        panel.dataset.mealIngredientsManualOverride = 'false';
        renderAppliedRecipeIngredients();
      };

      const finalizedParticipantCount = () => new Set(
        [...panel.querySelectorAll('[data-meal-role-user] [data-meal-role="participant"]:checked')]
          .map((input) => Number(input.closest('[data-meal-role-user]')?.dataset.mealRoleUser))
          .filter(Number.isFinite),
      ).size;

      recipeScaleInput?.addEventListener('input', () => {
        if (!recipeScaleInput.value) return;
        const factor = Number(recipeScaleInput.value);
        if (!Number.isFinite(factor) || factor <= 0) return;
        rescaleVisibleIngredients(factor);
      });

      const syncPortionControls = () => {
        if (!recipeScaleInput || !portionsModeSelect) return;
        const auto = portionsModeSelect.value === 'auto';
        recipeScaleInput.disabled = auto;
        if (auto) {
          recipeScaleInput.value = String(Math.max(finalizedParticipantCount(), 1));
          portionsModeSelect.options[0].textContent = `${mealText('meals.portionsAuto', 'Auto')} (${recipeScaleInput.value})`;
          rescaleVisibleIngredients(recipeScaleInput.value);
        }
      };
      portionsModeSelect?.addEventListener('change', syncPortionControls);

      panel.querySelectorAll('[data-meal-role]').forEach((input) => {
        input.addEventListener('change', () => {
          input.dataset.mealRoleTouched = 'true';
          if (input.checked) input.dataset.mealRoleStatus = 'participating';
          if (input.dataset.mealRole !== 'participant') return;
          if (portionsModeSelect?.value === 'auto') syncPortionControls();
        });
      });

      saveAsRecipeBtn?.addEventListener('click', async () => {
        const title = panel.querySelector('#modal-title').value.trim();
        if (!title) {
          reportFieldError(panel.querySelector('#modal-title'), t('common.nameRequired'));
          return;
        }

        const notes = panel.querySelector('#modal-notes').value.trim() || null;
        const recipe_url = panel.querySelector('#modal-recipe-url').value.trim() || null;
        const ingredients = collectModalIngredients(panel).map((ing) => ({
          name: ing.name,
          quantity: ing.quantity,
          category: ing.category,
        }));

        saveAsRecipeBtn.disabled = true;
        try {
          const created = await api.post('/recipes', { title, notes, recipe_url, ingredients });
          state.recipes.push(created.data);
          renderRecipeSidebar();

          if (recipeSelect) {
            recipeSelect.value = String(created.data.id);
            currentAppliedRecipe = created.data;
            panel.querySelector('#modal-recipe-list')?.insertAdjacentHTML(
              'beforeend',
              `<option value="${esc(created.data.title)}"></option>`,
            );
          }

          window.yuvomi?.showToast(t('recipes.created'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
        } finally {
          saveAsRecipeBtn.disabled = false;
        }
      });

      addIngBtn.addEventListener('click', () => {
        const tmp  = document.createElement('div');
        tmp.insertAdjacentHTML('beforeend', ingredientRowHTML({ categories: mealCategories() }));
        const row = tmp.firstElementChild;
        ingList.appendChild(row);
        panel.dataset.mealIngredientsManualOverride = 'true';
        if (window.lucide) lucide.createIcons({ el: ingList });
        row.querySelector('input').focus();
      });

      ingList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="remove-ingredient"]');
        if (btn) {
          btn.closest('.ingredient-row').remove();
          panel.dataset.mealIngredientsManualOverride = 'true';
        }
      });
      ingList.addEventListener('input', () => {
        panel.dataset.mealIngredientsManualOverride = 'true';
      });

      const syncSideRecipe = (row) => {
        const input = row.querySelector('[name="meal_side_title"]');
        const hidden = row.querySelector('[name="meal_side_recipe_id"]');
        const recipe = recipeForTitle(input?.value);
        if (hidden) hidden.value = recipe ? String(recipe.id) : '';
      };
      addSideBtn?.addEventListener('click', () => {
        if (sideList.querySelectorAll('[data-meal-side-row]').length >= 3) return;
        sideList.insertAdjacentHTML('beforeend', renderMealSideEditorRow());
        if (window.lucide) lucide.createIcons({ el: sideList });
        sideList.lastElementChild?.querySelector('[name="meal_side_title"]')?.focus();
        addSideBtn.disabled = sideList.querySelectorAll('[data-meal-side-row]').length >= 3;
      });
      sideList?.addEventListener('input', (event) => {
        const row = event.target.closest('[data-meal-side-row]');
        if (row) syncSideRecipe(row);
      });
      sideList?.addEventListener('click', (event) => {
        const remove = event.target.closest('[data-meal-side-remove]');
        if (!remove) return;
        remove.closest('[data-meal-side-row]')?.remove();
        addSideBtn.disabled = false;
      });
      if (addSideBtn) addSideBtn.disabled = sideList.querySelectorAll('[data-meal-side-row]').length >= 3;

      // Einkaufslisten-Transfer. Ohne Liste steht hier statt des toten
      // Auswahlfelds die geteilte Antwort samt Ausweg - `beforeLeave` schließt
      // das Modal, sonst bliebe es über dem Einkaufs-Tab stehen.
      mountMissingShoppingList(
        panel.querySelector('#transfer-missing'),
        { beforeLeave: () => closeModal({ force: true }) },
      );

      panel.querySelector('#transfer-btn')?.addEventListener('click', async () => {
        const selectEl = panel.querySelector('#transfer-list-select');
        const listId   = parseInt(selectEl?.value, 10);
        if (!listId || !state.modal?.meal) return;
        const btn = panel.querySelector('#transfer-btn');
        btn.disabled = true;
        try {
          const res = await api.post(`/meals/${state.modal.meal.id}/to-shopping-list`, { listId });
          if (res.data.transferred > 0) {
            await loadWeek(state.currentWeek);
            closeModal({ force: true });
            renderWeekGrid();
            // Dieselbe Meldung, Standzeit und Rücknahme wie am Slot-Knopf: es ist
            // derselbe Transfer, nur ein anderer Auslöser.
            announceTransfer({
              message: t('meals.transferSuccess', {
                count: res.data.transferred,
                list: state.lists.find((l) => l.id === listId)?.name ?? '',
              }),
              addedIds: res.data.added_ids ?? [],
              onUndone: async () => {
                await loadWeek(state.currentWeek);
                renderWeekGrid();
              },
            });
          } else {
            window.yuvomi?.showToast(t('meals.transferAlreadyDone'), 'info');
            btn.disabled = false;
          }
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
          btn.disabled = false;
        }
      });

      // Das Wiederholungs-Ende gehört zur Wiederholung, nicht zur Mahlzeit: es
      // zeigt sich nur, wenn die Serie überhaupt im Spiel ist - beim Anlegen mit
      // gesetztem Schalter, beim Bearbeiten im Serien-Umfang.
      panel.querySelector('#modal-cancel').addEventListener('click', closeModal);
      panel.querySelector('#modal-save').addEventListener('click', () => saveModal(panel));
      // Pflichtfelder melden sich beim Verlassen inline (geteiltes Muster).
      wireBlurValidation(panel);
    },
  });
}

function renderMealSideEditorRow(side = {}) {
  return `<div class="meal-side-editor-row" data-meal-side-row data-menu-item-id="${Number(side.id) || ''}">
    <label class="label"><span>${mealText('meals.side', 'Side')}</span><input class="form-input" name="meal_side_title" list="modal-recipe-list" maxlength="300" value="${esc(side.title || side.label || '')}" placeholder="${mealText('meals.recipeOrCustomPlaceholder', 'Choose a recipe or type a new side')}"><input type="hidden" name="meal_side_recipe_id" value="${Number(side.recipe_id) || ''}"></label>
    <button type="button" class="btn btn--ghost btn--sm" data-meal-side-remove aria-label="${esc(mealText('meals.removeSide', 'Remove side'))}"><i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i></button>
  </div>`;
}

function buildModalContent({ mode, date, mealType, meal, planningContextId = null }) {
  const isEdit   = mode === 'edit';
  const isRecurring = isEdit && meal.recurrence_template_id;
  const typeOpts = MEAL_TYPES().map((mt) =>
    `<option value="${mt.key}" ${mt.key === mealType ? 'selected' : ''}>${mt.label}</option>`
  ).join('');

  const listOpts = state.lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');

  const ingRows = isEdit && meal.ingredients?.length
    ? meal.ingredients.map((ing) => ingredientRowHTML({
        name: ing.name,
        quantity: ing.quantity ?? '',
        id: ing.id,
        category: ing.category ?? DEFAULT_CATEGORY_NAME,
        categories: mealCategories(),
      })).join('')
    : '';

  const hasIngOpen = isEdit && meal.ingredients?.some((i) => !i.on_shopping_list);

  // Account bleibt die flache Liste von vorher unverändert (kein UI-Rauschen).

  const advancedOpen = isEdit && (!!meal.recipe_id || !!meal.notes || !!meal.recipe_url || isRecurring || !!meal.scheduled_time || !!meal.place_id || !!meal.participants?.length);
  const finalizedParticipantIds = new Set(finalizedMealParticipantIds(meal?.participants || []));
  const initialIngredientScale = Math.max(Number(meal?.portions) || finalizedParticipantIds.size, 1);
  const initialPortionsMode = meal?.portions_mode === 'fixed' ? 'fixed' : 'auto';
  const sideItems = (meal?.menu_items || []).filter((item) => (item.item_type || item.kind) === 'side');

  const scopeOptions = [
    ['household', 'Household meal'], ['personal', 'Personal meal'], ['restaurant', 'Restaurant'],
    ['takeout', 'Takeout'], ['travel', 'Travel meal'],
  ].map(([value, label]) => `<option value="${value}" ${(meal?.scope || 'household') === value ? 'selected' : ''}>${label}</option>`).join('');
  const mealRoles = ['participant', 'chooser', 'cook', 'supervisor'];
  const participantRows = (state.planning.members || []).map((member) => {
    return `<div class="meal-role-row" data-meal-role-user="${member.id}"><strong>${esc(member.display_name)}</strong>${mealRoles.map((role) => {
      const roleState = mealEditorRoleState(meal?.participants || [], member.id, role);
      return `<label><input type="checkbox" data-meal-role="${role}" data-meal-role-present="${roleState.present}" data-meal-role-status="${esc(roleState.status)}" data-meal-role-touched="false" ${roleState.checked ? 'checked' : ''}> ${role[0].toUpperCase()}${role.slice(1)}</label>`;
    }).join('')}</div>`;
  }).join('');
  const selectedPlanningContext = planningContextId
    ? collectMealContexts(activeWeekModel()).find((context) => Number(context.id) === Number(planningContextId))
    : null;

  const planningFieldsHtml = `
    <div class="form-group"><label class="form-label" for="modal-meal-scope">Meal type and location</label><select class="form-input" id="modal-meal-scope">${scopeOptions}</select></div>
    <div class="form-group"><label class="form-label" for="modal-meal-place">Place</label><select class="form-input" id="modal-meal-place"><option value="">No specific Place</option>${(state.planning.places || []).map((place) => `<option value="${place.id}" ${Number(meal?.place_id) === Number(place.id) ? 'selected' : ''} ${!place.active && Number(meal?.place_id) !== Number(place.id) ? 'disabled' : ''}>${esc(place.name)}${place.active ? '' : ' (inactive)'}</option>`).join('')}</select><small class="form-hint">Used with participant availability and meal timing windows.</small></div>
    <div class="modal-grid modal-grid--2 meal-planning-times">
      <div class="form-group"><label class="form-label" for="modal-scheduled-time">Scheduled time</label><input class="form-input" type="time" id="modal-scheduled-time" value="${esc(meal?.scheduled_time || '')}"></div>
      <div class="form-group"><label class="form-label" for="modal-duration">Expected minutes</label><input class="form-input" type="number" min="1" max="720" id="modal-duration" value="${meal?.expected_duration_minutes || ''}"></div>
      <div class="form-group"><label class="form-label" for="modal-earliest-time">Earliest</label><input class="form-input" type="time" id="modal-earliest-time" value="${esc(meal?.earliest_time || '')}"></div>
      <div class="form-group"><label class="form-label" for="modal-preferred-time">Preferred</label><input class="form-input" type="time" id="modal-preferred-time" value="${esc(meal?.preferred_time || '')}"></div>
      <div class="form-group"><label class="form-label" for="modal-latest-time">Latest</label><input class="form-input" type="time" id="modal-latest-time" value="${esc(meal?.latest_time || '')}"></div>
    </div>
    <fieldset class="meal-role-grid"><legend class="form-label">People and roles</legend>${participantRows || '<p class="form-hint">Add household members to assign meal roles.</p>'}</fieldset>`;

  const advancedFieldsHtml = `
    ${planningFieldsHtml}
    <div class="form-group meal-save-recipe-action">
      <button class="btn btn--secondary" id="modal-save-as-recipe" type="button">${t('meals.saveAsRecipe')}</button>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-notes">${t('meals.notesLabel')}</label>
      <textarea class="form-input" id="modal-notes" rows="2"
                placeholder="${t('meals.notesPlaceholder')}">${esc(isEdit && meal.notes ? meal.notes : '')}</textarea>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-recipe-url">${t('meals.recipeUrlLabel')}</label>
      <input type="url" class="form-input" id="modal-recipe-url"
             placeholder="${t('meals.recipeUrlPlaceholder')}"
             value="${esc(isEdit && meal.recipe_url ? meal.recipe_url : '')}">
    </div>

    ${isEdit && isRecurring ? `<div class="meal-recurrence-note"><i data-lucide="repeat-2" class="icon-sm" aria-hidden="true"></i><span>${mealText('meals.legacyRecurringMealHint', 'This meal came from an older weekly series. This dialog edits only this date; use Meal Plans for future recurring meals.')}</span></div>` : ''}`;

  return `
    ${selectedPlanningContext ? `<div class="meal-plan-context-callout"><i data-lucide="plane" class="icon-sm" aria-hidden="true"></i><span><strong>${esc(selectedPlanningContext.name)}</strong><small>${mealText('meals.newMealContextHint', 'This one-off Meal belongs only to the selected planning context.')}</small></span></div>` : ''}
    <div class="modal-grid modal-grid--2">
      <div class="form-group">
        <label class="form-label" for="modal-date">${t('meals.dateLabel')}</label>
        <yuvomi-datepicker type="date" id="modal-date" value="${formatDateInput(date)}"></yuvomi-datepicker>
      </div>
      <div class="form-group">
        <label class="form-label" for="modal-type">${t('meals.mealTypeLabel')}</label>
        <select class="form-input" id="modal-type">${typeOpts}</select>
      </div>
    </div>

    <div class="form-group" style="position:relative;">
      <label class="form-label" for="modal-title">${mealText('meals.mealOrRecipe', 'Meal or recipe')}</label>
      <input type="text" class="form-input" id="modal-title" required
             list="modal-recipe-list" placeholder="${mealText('meals.recipeOrCustomPlaceholder', 'Choose a recipe or type a new meal')}"
             value="${esc(isEdit ? meal.title : '')}"
             autocomplete="off">
      <input type="hidden" id="modal-recipe-id" value="${Number(isEdit ? meal.recipe_id : null) || ''}">
      <datalist id="modal-recipe-list">${state.recipes.map((recipe) => `<option value="${esc(recipe.title)}"></option>`).join('')}</datalist>
      <small class="form-hint">${mealText('meals.recipeOrCustomHintShort', 'Choose a saved recipe or enter a new meal name.')}</small>
      <div id="modal-autocomplete" class="meal-modal__autocomplete" hidden></div>
    </div>

    <div class="form-group meal-ingredients-group">
      <div class="meal-ingredients-heading">
        <span class="form-label">${t('meals.ingredientsLabel')}</span>
        <div class="meal-ingredient-scale"><label class="label" for="modal-portions-mode"><span>${mealText('meals.portions', 'Portions')}</span><select class="form-input" id="modal-portions-mode"><option value="auto" ${initialPortionsMode === 'auto' ? 'selected' : ''}>${mealText('meals.portionsAuto', 'Auto')} (${initialIngredientScale})</option><option value="fixed" ${initialPortionsMode === 'fixed' ? 'selected' : ''}>${mealText('meals.portionsFixed', 'Fixed')}</option></select></label><label class="label" for="modal-recipe-scale"><span class="sr-only">${mealText('meals.portionCount', 'Portion count')}</span><input type="number" class="form-input" id="modal-recipe-scale" min="1" step="1" value="${initialIngredientScale}" ${initialPortionsMode === 'auto' ? 'disabled' : ''}></label></div>
      </div>
      <div class="ingredient-list" id="ingredient-list">${ingRows}</div>
      <button class="add-ingredient-btn" id="add-ingredient-btn" type="button">
        <i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>
        ${t('meals.addIngredient')}
      </button>
    </div>

    <div class="form-group meal-sides-group">
      <div class="meal-sides-heading"><span><strong>${mealText('meals.sides', 'Sides')}</strong><small>${mealText('meals.sidesHint', 'Optional dishes served with the main meal.')}</small></span><button type="button" class="btn btn--secondary btn--sm" id="modal-add-side"><i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>${mealText('meals.addSide', 'Add side')}</button></div>
      <div class="meal-side-editor" id="modal-side-list">${sideItems.map(renderMealSideEditorRow).join('')}</div>
    </div>

    ${advancedSection(advancedFieldsHtml, { open: advancedOpen })}

    ${isEdit && hasIngOpen ? `
    <div class="shopping-transfer">
      <div class="shopping-transfer__label">
        <i data-lucide="shopping-cart" class="icon-sm" aria-hidden="true"></i>
        ${t('meals.transferLabel')}
      </div>
      ${state.lists.length ? `
      <select class="shopping-transfer__select" id="transfer-list-select">${listOpts}</select>
      <button class="btn btn--secondary shopping-transfer__btn" id="transfer-btn" type="button">
        ${t('meals.transferNow')}
      </button>`
      // Ohne Liste stand hier ein Auswahlfeld mit einem deaktivierten
      // `<option>` als Begründung und daneben ein Knopf, der nichts tat - ein
      // Bedienelement, das den Grund seiner Nutzlosigkeit in sich trägt, ist die
      // schlechteste der vier Formen dieses Zustands, weil es bedienbar aussieht
      // (Audit 2026-07-30, P1-A). Der Platzhalter wird beim Verdrahten aus dem
      // geteilten Baustein gefüllt.
      : '<div id="transfer-missing" class="shopping-transfer__missing"></div>'}
    </div>` : ''}

    <div class="modal-panel__footer modal-panel__footer--plain">
      <button class="btn btn--secondary" id="modal-cancel">${t('common.cancel')}</button>
      <button class="btn btn--primary" id="modal-save">${isEdit ? t('common.save') : t('common.add')}</button>
    </div>`;
}

function closeModal({ force = false } = {}) {
  closeSharedModal({ force });
  state.modal = null;
}

async function saveModal(overlay) {
  const saveBtn   = overlay.querySelector('#modal-save');
  const dateRaw   = overlay.querySelector('#modal-date').value;
  const date      = parseDateInput(dateRaw);
  const meal_type = overlay.querySelector('#modal-type').value;
  const title     = overlay.querySelector('#modal-title').value.trim();
  const notes     = overlay.querySelector('#modal-notes').value.trim() || null;
  const recipe_url = overlay.querySelector('#modal-recipe-url').value.trim() || null;
  const recipe_id = overlay.querySelector('#modal-recipe-id')?.value || null;
  const meal_scope = overlay.querySelector('#modal-meal-scope')?.value || 'household';
  const place_id = Number(overlay.querySelector('#modal-meal-place')?.value) || null;
  const scheduled_time = overlay.querySelector('#modal-scheduled-time')?.value || null;
  const earliest_time = overlay.querySelector('#modal-earliest-time')?.value || null;
  const preferred_time = overlay.querySelector('#modal-preferred-time')?.value || null;
  const latest_time = overlay.querySelector('#modal-latest-time')?.value || null;
  const expected_duration_minutes = Number(overlay.querySelector('#modal-duration')?.value) || null;
  const portions_mode = overlay.querySelector('#modal-portions-mode')?.value === 'fixed' ? 'fixed' : 'auto';
  const portions = portions_mode === 'fixed' ? Number(overlay.querySelector('#modal-recipe-scale')?.value) : null;
  const overrideFlag = overlay.dataset.mealIngredientsManualOverride;
  const ingredients_manual_override = overrideFlag === undefined
    ? Boolean(state.modal?.meal?.ingredients_manual_override)
    : overrideFlag === 'true';
  const participants = [...overlay.querySelectorAll('[data-meal-role-user]')].flatMap((row) => (
    [...row.querySelectorAll('[data-meal-role]')]
      .map((input) => mealEditorRolePayload({
        userId: row.dataset.mealRoleUser,
        role: input.dataset.mealRole,
        checked: input.checked,
        touched: input.dataset.mealRoleTouched === 'true',
        originalPresent: input.dataset.mealRolePresent === 'true',
        originalStatus: input.dataset.mealRoleStatus,
      }))
      .filter(Boolean)
  ));
  // Das Wiederholungs-Ende zählt nur, solange die Serie im Spiel ist: beim
  // Anlegen mit gesetztem Schalter, beim Bearbeiten im Serien-Umfang. Sonst
  // steht im Feld zwar ein Wert, er gehört aber zu keiner der beiden Absichten.
  // Leeres Feld heißt „ohne Ende" und geht als leerer String raus: der Server
  // unterscheidet das ausdrücklich vom fehlenden Feld (Ende bleibt unverändert).
  if (!date || !isDateInputValid(dateRaw)) {
    reportFieldError(overlay.querySelector('#modal-date'), t('calendar.invalidDate'));
    return;
  }

  if (!title) {
    reportFieldError(overlay.querySelector('#modal-title'), t('common.nameRequired'));
    return;
  }

  if (portions_mode === 'fixed' && (!Number.isInteger(portions) || portions < 1)) {
    reportFieldError(
      overlay.querySelector('#modal-recipe-scale'),
      mealText('meals.portionCountInvalid', 'Enter at least one portion.'),
    );
    return;
  }

  const ingredients = collectModalIngredients(overlay);
  const menu_items = [
    { item_type: 'entree', title, recipe_id: recipe_id || null, position: 0 },
    ...[...overlay.querySelectorAll('[data-meal-side-row]')]
      .map((row, index) => ({
        item_type: 'side',
        title: row.querySelector('[name="meal_side_title"]')?.value.trim() || '',
        recipe_id: row.querySelector('[name="meal_side_recipe_id"]')?.value || null,
        position: index,
      }))
      .filter((item) => item.title),
  ];

  saveBtn.disabled    = true;
  saveBtn.textContent = '…';

  try {
    const { mode, meal } = state.modal;

    if (mode === 'create') {
      const res = await api.post('/meals', {
        date, meal_type, title, notes, recipe_url, recipe_id, ingredients, menu_items,
        portions_mode, portions, ingredients_manual_override,
        scope: meal_scope, scheduled_time, earliest_time, preferred_time, latest_time,
        expected_duration_minutes, participants, place_id,
        planning_context_id: state.modal?.planningContextId || null,
      });
      state.meals.push(res.data);
    } else {
      // Recurrence belongs to Meal Plans; this editor changes one dated Meal.
        await api.put(`/meals/${meal.id}`, {
          date, meal_type, title, notes, recipe_url, recipe_id, ingredients, menu_items,
          portions_mode, portions, ingredients_manual_override,
          scope: meal_scope, scheduled_time, earliest_time, preferred_time, latest_time,
          expected_duration_minutes, participants, place_id,
        });

    }

    await Promise.all([loadWeek(state.currentWeek), loadWeekExperience()]);
    closeModal({ force: true });
    renderWeekExperienceHeader();
    renderWeekGrid();
    window.yuvomi?.showToast(mode === 'create' ? t('meals.addMealTitle') : t('meals.editMeal'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    saveBtn.disabled    = false;
    saveBtn.textContent = state.modal?.mode === 'edit' ? t('common.save') : t('common.add');
  }
}

function collectModalIngredients(overlay) {
  const ingredients = [];
  overlay.querySelectorAll('.ingredient-row').forEach((row) => {
    const name = row.querySelector('.ingredient-row__name').value.trim();
    const qty = row.querySelector('.ingredient-row__qty').value.trim() || null;
    const category = row.querySelector('.ingredient-row__cat')?.value || DEFAULT_CATEGORY_NAME;
    if (name) ingredients.push({ name, quantity: qty, category, id: row.dataset.ingId || null });
  });
  return ingredients;
}

// --------------------------------------------------------
// Mahlzeit löschen
// --------------------------------------------------------

async function deleteMeal(mealId) {
  const meal = state.meals.find((m) => m.id === mealId);

  // Wiederkehrende Mahlzeit: Einzeltermin, alles ab hier oder ganze Serie löschen.
  // „Ab hier" ist der Ausweg, wenn die Serie in der Vergangenheit sinnvoll war und
  // nur nach vorn enden soll - ohne ihn blieb nur, jedes künftige Vorkommen
  // einzeln zu löschen, während die nächste Woche schon wieder eines erzeugte (#619).
  if (meal?.recurrence_template_id) {
    const choice = await selectModal(t('meals.deleteRecurringTitle'), [
      { value: 'single', label: t('meals.deleteScopeSingle') },
      { value: 'future', label: t('meals.deleteScopeFuture') },
      { value: 'series', label: t('meals.deleteScopeSeries') },
    ]);
    if (choice === null) return;

    if (choice === 'series' || choice === 'future') {
      try {
        await api.delete(`/meals/${mealId}?scope=${choice}`);
        await Promise.all([loadWeek(state.currentWeek), loadWeekExperience()]);
        renderWeekExperienceHeader();
        renderWeekGrid();
        window.yuvomi?.showToast(
          choice === 'future' ? t('meals.seriesEndedToast') : t('meals.seriesDeletedToast'),
          'success',
        );
      } catch (err) {
        window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
      }
      return;
    }
    // choice === 'single' → weiter mit der Undo-Löschung unten
  }

  const itemEl = _container.querySelector(`.meal-card[data-meal-id="${mealId}"]`);
  if (itemEl) itemEl.style.display = 'none';

  scheduleUndoableDelete({
    message: t('meals.deletedToast'),
    commit: async ({ keepalive }) => {
      await api.delete(`/meals/${mealId}`, { keepalive });
      if (keepalive) return; // Seite verschwindet - kein UI-Refresh mehr
      state.meals = state.meals.filter((m) => m.id !== mealId);
      await loadWeekExperience();
      renderWeekExperienceHeader();
      renderWeekGrid();
    },
    restore: (err) => {
      if (itemEl) itemEl.style.display = '';
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}

// --------------------------------------------------------
// Zutaten → Einkaufsliste (Quick-Transfer vom Slot aus)
// --------------------------------------------------------

async function transferMeal(mealId, btn) {
  // Vorprüfung, Listenwahl und die Antwort auf „es gibt keine Liste" liegen im
  // geteilten Baustein (utils/kitchen-transfer.js).
  const target = await resolveShoppingTarget(state.lists);
  if (!target) return;

  if (btn) btn.disabled = true;
  try {
    const res = await api.post(`/meals/${mealId}/to-shopping-list`, { listId: target.id });
    if (res.data.transferred > 0) {
      await loadWeek(state.currentWeek);
      renderWeekGrid();
      // Der Toast nennt die ZIEL-Liste. „5 Zutaten übernommen." sagte nicht, wohin -
      // und bei mehreren Listen ist genau das die Frage, die offen bleibt (Critique
      // 2026-07-30, P1). Der Kreislauf endet nicht mit „übernommen", sondern in
      // einer bestimmten Liste.
      //
      // `onUndone` zeichnet die Woche neu: die Rücknahme setzt serverseitig auch
      // `on_shopping_list` zurück, die Zutaten sind danach wieder offen - und die
      // Kachel zeigt den Übernahme-Knopf wieder an.
      announceTransfer({
        message: t('meals.transferSuccess', { count: res.data.transferred, list: target.name }),
        addedIds: res.data.added_ids ?? [],
        onUndone: async () => {
          await loadWeek(state.currentWeek);
          renderWeekGrid();
        },
      });
    } else {
      window.yuvomi?.showToast(t('meals.transferAlreadyDone'), 'info');
    }
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  } finally {
    // Die Kachel wird nach einem Erfolg neu gezeichnet; der Knopf hier ist dann
    // schon ersetzt. Das Zurücksetzen gilt dem Fehlerfall und dem Nichts-zu-tun-Fall.
    if (btn?.isConnected) btn.disabled = false;
  }
}

export const __test = {
  buildRandomMealAssignments,
  mealPayloadFromRecipe,
  normalizeDayHeaderDateLabel,
};

// --------------------------------------------------------
// Hilfsfunktion
// --------------------------------------------------------
