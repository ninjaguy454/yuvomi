/**
 * Modul: Aufgaben (Tasks)
 * Zweck: Listenansicht mit Filtern, Gruppierung, CRUD-Modal, Subtask-Verwaltung
 * Abhängigkeiten: /api.js
 */

import { api } from '/api.js';
import { renderRRuleFields, bindRRuleEvents, getRRuleValues, describeRRule } from '/rrule-ui.js';
import { openModal as openSharedModal, closeModal, wireBlurValidation, validateAll, btnSuccess, btnError, btnLoading, advancedSection } from '/components/modal.js';
import { stagger, vibrate, scheduleUndoableDelete, animationSettled } from '/utils/ux.js';
import { wireSwipeRows, maybeShowSwipeHint } from '/utils/swipe-row.js';
import { t, getLocale, formatDate, formatDayMonth, formatTime, formatDateInput, parseDateInput, isDateInputValid, formatTimeInput, parseTimeInput } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderMarkdownToolbar, wireMarkdownToolbar } from '/utils/markdown-toolbar.js';
import { refresh as refreshReminders } from '/reminders.js';
import { renderUserMultiSelect, getSelectedUserIds, bindUserMultiSelect, renderAvatarStack } from '/components/user-multi-select.js';
import { renderUserRotationOrder, getRotationUserIds } from '/components/user-rotation-order.js';
import { openQuickAdd } from '/components/activity-automation.js';
import { resolveReminderPreset } from '/utils/reminder-offset.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { renderDocumentAttachField, bindDocumentAttachField } from '/components/document-attach.js';
import { emptyStateHTML, mountLoadError } from '/utils/empty-state.js';
import '/components/category-manager.js';
import '/components/tag-manager.js';
import { findPageFab } from '/utils/fab.js';
import { isSoloHousehold } from '/utils/household.js';
import {
  todayKey, parseLocalDateKey, addLocalDays, toLocalDateKey,
  startOfLocalWeekKey, weekStartIndex, weekdayOrder, isWeekendKey,
} from '/utils/date.js';
import { nowFields, zonedDateKey, zonedUTCProxy } from '/utils/timezone.js';
import { isWallModeEnabled } from '/utils/wall-mode.js';
import { historyDayLabel } from '/utils/day-label.js';
import {
  PRIORITIES, PRIO_ORDER, STATUSES, FILTER_STATUSES, PRIORITY_LABELS, STATUS_LABELS,
  FALLBACK_CATEGORY, isArchived, formatDueDate, normalizeTagList,
  normalizeParticipant, taskParticipants, subtaskParticipants,
  completionCounts, taskLocationLabel,
  catLabel as catLabelOf, catSortIndex as catSortIndexOf,
  canEditTaskDefinition as canEditTaskDefinitionFor,
} from '/utils/task-fields.js';
import {
  openTaskDetail, deleteTaskWithUndo, addSubtask, renameSubtask, deleteSubtask,
  setTaskArchived, toggleSubtaskStatus,
} from '/components/task-detail.js';

// --------------------------------------------------------
// Die geteilten Regeln, mit dem Blickwinkel DIESER Seite
//
// Was ein Feld bedeutet, steht seit #918 in utils/task-fields.js, damit die
// Leseansicht dieselbe Antwort gibt, egal wer sie oeffnet. Zwei dieser Regeln
// brauchen Kontext, den nur eine Ansicht hat: wer gerade schaut und welche
// Kategorien der Haushalt fuehrt. Die Wrapper hier setzen ihn ein, damit die
// Aufrufe in dieser Datei so kurz bleiben wie zuvor.
// --------------------------------------------------------

/** Wer schaut - fuer die Sperrregel aus #830. */
function viewer() {
  return { isAdmin: state.isAdmin, currentUserId: state.currentUserId };
}

function canEditTaskDefinition(task, parent = null) {
  return canEditTaskDefinitionFor(task, parent, viewer());
}

function catLabel(key, categories = state.categories) {
  return catLabelOf(key, categories);
}

function catSortIndex(key, categories = state.categories) {
  return catSortIndexOf(key, categories);
}

const TASK_GROUP_MODES_KEY = 'yuvomi:taskGroupModes';
const TASK_SORT_STATE_KEY = 'yuvomi:taskSortState';
const TASK_PROGRESS_MODE_KEY = 'yuvomi:taskProgressMode';

const GROUP_FIELDS = () => [
  { value: 'none', label: t('tasks.groupNone'), icon: 'rows-3' },
  { value: 'assignee', label: t('tasks.groupAssignee'), icon: 'users' },
  { value: 'category', label: t('tasks.categoryLabel'), icon: 'folder' },
  { value: 'due', label: t('tasks.dueDateLabel'), icon: 'calendar-clock' },
  { value: 'location', label: t('tasks.groupLocation'), icon: 'map-pin' },
  { value: 'status', label: t('tasks.statusLabel'), icon: 'circle-dot' },
];

const SORT_FIELDS = () => [
  { value: 'default', label: t('tasks.sortDefault') },
  { value: 'title', label: t('tasks.titleLabel') },
  { value: 'assignees', label: t('tasks.sortAssignees') },
  { value: 'points', label: t('tasks.sortPoints') },
  { value: 'subtasks', label: t('tasks.sortSubtasks') },
  { value: 'category', label: t('tasks.categoryLabel') },
  { value: 'due', label: t('tasks.dueDateLabel') },
  { value: 'location', label: t('tasks.groupLocation') },
  { value: 'progress', label: t('tasks.sortProgress') },
];

const PROGRESS_MODES = () => [
  { value: 'percent', label: t('tasks.progressPercent') },
  { value: 'count', label: t('tasks.progressCount') },
  { value: 'points', label: t('tasks.progressPoints') },
];
// --------------------------------------------------------
// Verknüpfte Dokumente (#503, #733)
//
// Das Feld ist seit #733 die geteilte Komponente aus components/document-attach.js
// - dieselbe, die Budget, Gemeinsame Ausgaben und Inventar benutzen. Vorher
// führten die Aufgaben als einziges Modul eine eigene Auswahlliste, und die
// konnte nur verknüpfen, was schon abgelegt war: eine Datei AN der Aufgabe
// hochzuladen ging nirgends, obwohl der Baustein dafür seit #583 im Haus liegt.
//
// `taskDocuments` ist der Controller des offenen Formulars. commit() lädt
// wartende Dateien hoch und liefert die vollständige ID-Liste, die
// handleFormSubmit als Replace-Set an PUT /tasks/:id/documents gibt.
let taskDocuments = null;

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

function initials(name = '') {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

/** Progress for the first-class subtasks assigned to one household member. */
function participantCompletion(task, userId) {
  const assigned = (task.subtasks || []).filter((subtask) =>
    subtaskParticipants(subtask, state.users).some((user) => Number(user.id) === Number(userId))
  );
  if (!assigned.length) return completionCounts(task);
  return {
    done: assigned.filter((subtask) => subtask.status === 'done').length,
    total: assigned.length,
    earnedPoints: assigned.filter((subtask) => subtask.status === 'done')
      .reduce((sum, subtask) => sum + Number(subtask.points || 0), 0),
    totalPoints: assigned.reduce((sum, subtask) => sum + Number(subtask.points || 0), 0),
  };
}

function progressLabel(progress) {
  if (state.progressMode === 'count') return t('tasks.progressCountValue', progress);
  if (state.progressMode === 'points' && progress.totalPoints > 0) {
    return t('tasks.progressPointsValue', progress);
  }
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return t('tasks.progressPercentValue', { percent });
}

function taskProgress(task) {
  const progress = completionCounts(task);
  return progress.total ? progress.done / progress.total : 0;
}

function compareTaskField(a, b, field) {
  const collator = new Intl.Collator(getLocale(), { numeric: true, sensitivity: 'base' });
  const text = (value) => String(value || '');
  const number = (value) => Number(value || 0);
  if (field === 'title') return collator.compare(text(a.title), text(b.title));
  if (field === 'assignees') return taskParticipants(a).length - taskParticipants(b).length;
  if (field === 'points') return number(a.points) - number(b.points);
  if (field === 'subtasks') return number(a.subtask_total) - number(b.subtask_total);
  if (field === 'category') return collator.compare(catLabel(a.category), catLabel(b.category));
  if (field === 'location') return collator.compare(taskLocationLabel(a), taskLocationLabel(b));
  if (field === 'progress') return taskProgress(a) - taskProgress(b);
  if (field === 'due') {
    const av = effectiveDue(a)?.getTime() ?? Number.POSITIVE_INFINITY;
    const bv = effectiveDue(b)?.getTime() ?? Number.POSITIVE_INFINITY;
    return av - bv;
  }
  return sortTasks(a, b, new Date());
}

function sortedTasks(tasks, bucketKey = null) {
  const local = bucketKey ? state.bucketSorts.get(bucketKey) : null;
  const sort = local || state.sheetSort;
  const field = sort?.field || 'default';
  const direction = sort?.direction === 'desc' ? -1 : 1;
  return [...tasks].sort((a, b) => {
    const compared = compareTaskField(a, b, field);
    if (compared) return compared * direction;
    const title = String(a.title || '').localeCompare(String(b.title || ''), getLocale(), { sensitivity: 'base' });
    return title || Number(a.id) - Number(b.id);
  });
}

function boardTasks() {
  const tasks = filteredTasks();
  if (state.boardScope !== 'personal') return tasks;
  return tasks.filter((task) => task.activity_assignment_state === 'open'
    || taskParticipants(task).some((user) => Number(user.id) === Number(state.currentUserId)));
}

function taskBuckets(tasks, mode, { includeEmptyAssignees = false } = {}) {
  if (mode === 'none') return [{ id: 'all', label: t('tasks.groupAll'), tasks }];
  if (mode === 'assignee') {
    const buckets = new Map();
    if (includeEmptyAssignees) {
      state.users.forEach((user) => buckets.set(`user-${user.id}`, { id: `user-${user.id}`, label: user.display_name, tasks: [], user }));
    }
    for (const task of tasks) {
      const people = taskParticipants(task);
      if (!people.length) {
        const bucket = buckets.get('unassigned') || { id: 'unassigned', label: t('tasks.groupUnassigned'), tasks: [] };
        bucket.tasks.push(task);
        buckets.set('unassigned', bucket);
        continue;
      }
      for (const user of people) {
        const key = `user-${user.id}`;
        const bucket = buckets.get(key) || { id: key, label: user.display_name, tasks: [], user };
        bucket.tasks.push(task);
        buckets.set(key, bucket);
      }
    }
    return [...buckets.values()];
  }
  if (mode === 'category') return groupBy(tasks, 'category');
  if (mode === 'due') return groupBy(tasks, 'due');
  if (mode === 'status') {
    const order = [...STATUSES(), { value: 'archived', label: t('tasks.statusArchived') }];
    return order.map((status) => ({
      id: status.value,
      label: status.label,
      tasks: tasks.filter((task) => kanbanColumnOf(task) === status.value),
    })).filter((bucket) => bucket.tasks.length);
  }
  if (mode === 'location') {
    const buckets = new Map();
    for (const task of tasks) {
      const label = taskLocationLabel(task) || t('tasks.groupNoLocation');
      const id = task.location?.place_id ? `place-${task.location.place_id}` : `location-${label.toLocaleLowerCase()}`;
      const bucket = buckets.get(id) || { id, label, tasks: [] };
      bucket.tasks.push(task);
      buckets.set(id, bucket);
    }
    return [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label, getLocale(), { sensitivity: 'base' }));
  }
  return [{ id: 'all', label: t('tasks.groupAll'), tasks }];
}

// Sichtbarkeits-Indikator (#474): nur für eingeschränkte Elemente ein dezentes
// Icon — „Alle" bleibt icon-los (keine visuelle Flut, „Kraft ohne Lärm").
function renderVisibilityBadge(visibility) {
  if (!visibility || visibility === 'all') return '';
  const icon  = visibility === 'private' ? 'lock' : 'users';
  const label = visibility === 'private'
    ? t('common.visibility.private')
    : t('common.visibility.assignees');
  return `<span class="due-date task-card__visibility" title="${esc(label)}" aria-label="${esc(label)}">
            <i data-lucide="${icon}" class="icon-sm" aria-hidden="true"></i>
          </span>`;
}

/**
 * Gruppiert die Aufgaben und gibt je Gruppe `{ id, label, tasks }`.
 *
 * Die `id` ist bewusst NICHT das angezeigte Label: eingeklappte Gruppen werden
 * gespeichert (#812), und ein uebersetzter Name als Schluessel haette den
 * Zustand bei jedem Sprachwechsel verloren - „Heute" und „Today" waeren zwei
 * verschiedene Gruppen. Die Kategorie bringt ihren stabilen Schluessel schon
 * mit, die Faelligkeits-Gruppen bekommen hier feste Namen.
 */
/** Schluessel einer Gruppe im Speicher: Modus und Id zusammen. */
function groupKey(mode, id) {
  return `${mode}:${id}`;
}

function isGroupCollapsed(mode, id) {
  return state.collapsedGroups.has(groupKey(mode, id));
}

/**
 * Klappt eine Gruppe um und merkt sich das (#812).
 *
 * Gespeichert wird nur, was EINGEKLAPPT ist: eine neue Gruppe - eine frisch
 * angelegte Kategorie, „Ueberfaellig" beim ersten ueberfaelligen Eintrag -
 * erscheint damit offen. Die Umkehrung haette sie versteckt, obwohl niemand sie
 * je zugeklappt hat.
 */
function toggleGroup(mode, id) {
  const key = groupKey(mode, id);
  if (state.collapsedGroups.has(key)) state.collapsedGroups.delete(key);
  else state.collapsedGroups.add(key);
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...state.collapsedGroups]));
  } catch { /* Privatmodus/Quota: der Zustand gilt dann nur fuer diese Sitzung */ }
}

function loadCollapsedGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? '[]');
    state.collapsedGroups = new Set(Array.isArray(raw) ? raw.filter((k) => typeof k === 'string') : []);
  } catch {
    state.collapsedGroups = new Set();
  }
}

function groupBy(tasks, mode, categories = state.categories) {
  const groups = {};

  if (mode === 'category') {
    for (const t of tasks) {
      const key = t.category || FALLBACK_CATEGORY;
      (groups[key] = groups[key] || []).push(t);
    }
    return Object.entries(groups)
      // Unbekannte Keys landen alle auf demselben Index - erst dahinter darf
      // das Alphabet entscheiden, und dann über das Label in der aktiven
      // Sprache statt über den Schlüssel.
      .sort(([a], [b]) => catSortIndex(a, categories) - catSortIndex(b, categories)
        || catLabel(a, categories).localeCompare(catLabel(b, categories), getLocale()))
      .map(([key, list]) => ({ id: key, label: catLabel(key, categories), tasks: list }));
  }

  // mode === 'due'
  const groupOverdue  = t('tasks.groupOverdue');
  const groupToday    = t('tasks.groupToday');
  const groupThisWeek = t('tasks.groupThisWeek');
  const groupNextWeek = t('tasks.groupNextWeek');
  const groupLater    = t('tasks.groupLater');
  const groupNoDate   = t('tasks.groupNoDate');

  for (const task of tasks) {
    let key;
    if (!task.due_date)                  key = groupNoDate;
    else {
      // Beide Seiten als KALENDERTAG rechnen, nicht als Instant.
      //
      // `new Date('2026-08-24')` ist UTC-Mitternacht, `setHours(0,0,0,0)` die
      // lokale - die Differenz trug damit den Zonen-Offset mit. Ab +12 Stunden
      // rundete sie auf einen ganzen Tag auf, und eine heute faellige Aufgabe
      // stand in Neuseeland unter „Diese Woche" statt unter „Heute" (in
      // Kiritimati ebenso). Der Kalendertag kommt jetzt aus `todayKey()` und
      // folgt damit derselben Zone wie der Rest der App (#829).
      const diff = Math.round(
        (parseLocalDateKey(task.due_date) - parseLocalDateKey(todayKey())) / 86400000,
      );
      if (diff < 0)       key = groupOverdue;
      else if (diff === 0) key = groupToday;
      else if (diff <= 3)  key = groupThisWeek;
      else if (diff <= 7)  key = groupNextWeek;
      else                 key = groupLater;
    }
    (groups[key] = groups[key] || []).push(task);
  }

  const order = [
    ['overdue',  groupOverdue],
    ['today',    groupToday],
    ['thisWeek', groupThisWeek],
    ['nextWeek', groupNextWeek],
    ['later',    groupLater],
    ['noDate',   groupNoDate],
  ];
  return order
    .filter(([, label]) => groups[label])
    .map(([id, label]) => ({ id, label, tasks: groups[label] }));
}

// --------------------------------------------------------
// Render-Bausteine
// --------------------------------------------------------

// Die Stufe steht am PUNKT, nicht am Etikett: seit die Fuellung entfallen ist
// (Skalen-Regel, DESIGN.md) traegt `.priority-badge` keine Farbe mehr, und eine
// Modifier-Klasse ohne Regel ist tote Auszeichnung.
function renderPriorityBadge(priority) {
  if (priority === 'none') return '';
  return `<span class="priority-badge">
    <span class="priority-dot priority-dot--${priority}"></span>
    ${PRIORITY_LABELS()[priority] ?? priority}
  </span>`;
}

function renderDueDate(dateStr, timeStr, isDone = false) {
  const d = formatDueDate(dateStr, timeStr, isDone);
  if (!d) return '';
  return `<span class="due-date ${d.cls}">
    <i data-lucide="clock" class="icon-sm" aria-hidden="true"></i> ${d.label}
  </span>`;
}

function renderStartDateBadge(startDateStr) {
  if (!startDateStr) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDay = new Date(`${startDateStr}T00:00:00`);
  if (startDay <= today) return '';
  return `<span class="due-date">
    <i data-lucide="calendar-clock" class="icon-sm" aria-hidden="true"></i> ${t('tasks.startsOn', { date: formatDate(startDay) })}
  </span>`;
}

function renderSwipeRow(task, innerHtml) {
  const isDone = task.status === 'done';
  return `
    <div class="swipe-row" data-swipe-id="${task.id}" data-swipe-status="${task.status}">
      <div class="swipe-reveal swipe-reveal--done swipe-reveal--leading" aria-hidden="true">
        <i data-lucide="${isDone ? 'rotate-ccw' : 'check'}" class="icon-xl" aria-hidden="true"></i>
        <span>${isDone ? t('tasks.swipeOpen') : t('tasks.swipeDone')}</span>
      </div>
      <div class="swipe-reveal swipe-reveal--edit swipe-reveal--trailing" aria-hidden="true">
        <i data-lucide="eye" class="icon-xl" aria-hidden="true"></i>
        <span>${t('tasks.swipeView')}</span>
      </div>
      ${innerHtml}
    </div>`;
}

// --------------------------------------------------------
// Sync-Ziel einer neuen Aufgabe (#695)
// --------------------------------------------------------

/**
 * Das Ziel-Feld des Aufgaben-Dialogs.
 *
 * Es fehlt in zwei Faellen, und beide sind Aussagen ueber die Aufgabe, nicht
 * ueber die Oberflaeche:
 *
 * - Unteraufgaben tragen kein eigenes Ziel. Sie gehoeren zu ihrer Elternaufgabe,
 *   und als eigenstaendiges VTODO stuenden sie auf dem Server gleichrangig
 *   daneben.
 * - Eine bereits hochgeladene Aufgabe kann ihre Liste nicht mehr wechseln: einen
 *   Umzug zwischen Listen gibt es bewusst nicht. Statt eines toten Dropdowns
 *   steht dort ein Satz, der sagt, dass sie abgeglichen wird - sonst sieht die
 *   Maske aus, als haette man die Wahl vergessen.
 */
function syncTargetFieldHtml(task) {
  if (task?.parent_task_id) return '';

  if (task?.external_source === 'caldav') {
    return `
      <div class="form-group">
        <span class="label">${t('tasks.syncTargetLabel')}</span>
        <p class="form-hint">${t('tasks.syncTargetMirrored')}</p>
      </div>
`;
  }

  return `
      <div class="form-group">
        <label class="label" for="task-sync-target">${t('tasks.syncTargetLabel')}</label>
        <select class="input" id="task-sync-target" name="sync_target">
          <option value="">${t('tasks.syncTargetLocal')}</option>
        </select>
        <small class="form-hint">${t('tasks.syncTargetHint')}</small>
      </div>
`;
}

/**
 * Fuellt das Ziel-Feld aus /tasks/sync-targets.
 *
 * Faellt der Aufruf aus, bleibt die einzige Option "nur lokal" stehen - das ist
 * derselbe Zustand wie ohne eingerichtete Erinnerungsliste und verliert nichts:
 * ein nicht gesetztes Ziel laesst die Aufgabe lokal, so wie bisher jede.
 *
 * Ein gespeichertes, aber nicht mehr angebotenes Ziel wird nachgetragen, damit
 * die Maske nicht "nur lokal" behauptet, waehrend die Aufgabe auf eine Liste
 * wartet. Der persoenliche Standard dagegen wird NICHT nachgetragen: er soll
 * eine neue Aufgabe nicht auf eine Liste richten, die es nicht mehr gibt.
 */
async function wireSyncTarget(panel, task) {
  const select = panel.querySelector('#task-sync-target');
  if (!select) return;

  let lists = [];
  try {
    const res = await api.get('/tasks/sync-targets');
    lists = res.data?.caldav ?? [];
  } catch (err) {
    console.warn('[Tasks] Sync-Ziele nicht ladbar:', err.message);
  }

  const current = task?.target_caldav_account_id && task?.target_caldav_list_url
    ? `caldav:${task.target_caldav_account_id}|${task.target_caldav_list_url}`
    : '';

  const byAccount = new Map();
  for (const list of lists) {
    if (!byAccount.has(list.accountName)) byAccount.set(list.accountName, []);
    byAccount.get(list.accountName).push(list);
  }

  for (const [accountName, group] of byAccount) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = accountName;
    for (const list of group) {
      const option = document.createElement('option');
      option.value = `caldav:${list.accountId}|${list.listUrl}`;
      option.textContent = list.listName || list.listUrl;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }

  if (current && !Array.from(select.options).some((o) => o.value === current)) {
    const option = document.createElement('option');
    option.value = current;
    option.textContent = t('tasks.syncTargetUnavailable');
    select.appendChild(option);
  }

  const wanted = current || (task ? '' : state.defaultSyncTarget);
  if (wanted && Array.from(select.options).some((o) => o.value === wanted)) {
    select.value = wanted;
  }
}

/**
 * EINE Metazeile, und sie bricht nicht um.
 *
 * Die Zeile trug bis zu acht Elemente mit `flex-wrap: wrap` und wurde damit je
 * nach Aufgabe zwei- bis dreizeilig - der eigentliche Höhentreiber der Liste,
 * nicht die Polsterung. Drei Regeln nehmen das zurück, ohne Information zu
 * verstecken, die es nur hier gibt:
 *
 * 1. ZWEI DATEN SIND EINS ZU VIEL. Das Startdatum erscheint nur, wenn es keine
 *    Fälligkeit gibt. Steht beides an, ist die Fälligkeit die Frage, die die
 *    Liste beantwortet; der Beginn steht in der Detailfläche.
 * 2. DIE KATEGORIE STEHT NICHT ZWEIMAL. Beim Gruppieren nach Kategorie ist der
 *    Gruppenkopf darüber schon die Antwort - das Etikett wiederholte ihn in
 *    jeder Zeile der Gruppe.
 * 3. EIN TAG STATT DREI, der Rest als „+N". Der Marker existiert bereits
 *    (.task-tag--more) und sagt, dass etwas fehlt - das tut ein Abschnitt nicht.
 *
 * Anhänge werden zur reinen Glyphe: die Zahl daneben war die einzige Stelle der
 * Zeile, an der eine Anzahl OHNE ihren Gegenstand stand.
 */
function renderLegacyTaskCard(task, opts = {}) {
  const { expandedSubtasks = false, showCheckbox = false, isChecked = false, showCategory = true } = opts;
  const isDone = task.status === 'done';
  const archived = isArchived(task);
  // Gesperrte Aufgabe (#830): abhaken bleibt, umschreiben nicht. Die Knoepfe,
  // die in einem 403 endeten, stehen deshalb gar nicht erst da.
  const canEdit = canEditTaskDefinition(task);
  const progress = task.subtask_total > 0
    ? Math.round((task.subtask_done / task.subtask_total) * 100)
    : null;

  const subtasksHtml = task.subtasks?.length
    ? task.subtasks.map((s) => `
        <div class="subtask-item ${s.status === 'done' ? 'subtask-item--done' : ''}"
             data-subtask-id="${s.id}">
          <button class="subtask-item__checkbox ${s.status === 'done' ? 'subtask-item__checkbox--done' : ''}"
                  data-action="toggle-subtask" data-id="${s.id}"
                  data-status="${s.status}" aria-label="${t('tasks.subtaskMarkDone', { title: esc(s.title) })}">
            ${s.status === 'done' ? '<i data-lucide="check" class="subtask-item__checkbox-icon" aria-hidden="true"></i>' : ''}
          </button>
          <button type="button" class="subtask-item__title" data-action="open-task" data-id="${s.id}">${esc(s.title)}</button>
          ${s.assigned_name ? `<span class="subtask-item__assignee">${esc(s.assigned_name)}</span>` : ''}
          ${canEditTaskDefinition(s, task) ? `
          <div class="subtask-item__actions">
            <button class="btn btn--ghost btn--icon btn--icon-sm subtask-item__action"
                    data-action="rename-subtask" data-id="${s.id}" data-title="${esc(s.title)}"
                    aria-label="${t('tasks.subtaskRename', { title: esc(s.title) })}">
              <i data-lucide="pencil" aria-hidden="true"></i>
            </button>
            <button class="btn btn--ghost btn--icon btn--icon-sm subtask-item__action"
                    data-action="delete-subtask" data-id="${s.id}" data-title="${esc(s.title)}"
                    aria-label="${t('tasks.subtaskDelete', { title: esc(s.title) })}">
              <i data-lucide="trash-2" aria-hidden="true"></i>
            </button>
          </div>` : ''}
        </div>`).join('')
    : '';

  return `
    <div class="task-card ${isDone ? 'task-card--done' : ''} ${archived ? 'task-card--archived' : ''}" data-task-id="${task.id}">
      <div class="list-row list-row--roomy task-card__main">
        ${showCheckbox ? `
        <input type="checkbox" class="task-bulk-checkbox" data-task-id="${task.id}"
               ${isChecked ? 'checked' : ''} aria-label="${t('tasks.selectTask')}">
        ` : ''}
        <button class="task-status-btn task-status-btn--${task.status}"
                data-action="toggle-status" data-id="${task.id}" data-status="${task.status}"
                aria-label="${isDone ? t('tasks.markOpen', { title: esc(task.title) }) : t('tasks.markDone', { title: esc(task.title) })}">
          <i data-lucide="check" class="task-status-btn__check" aria-hidden="true"></i>
        </button>

        <div class="task-card__body" data-action="open-task" data-id="${task.id}"
             role="button" tabindex="0" aria-label="${esc(task.title)}">
          <span class="task-card__title u-card-title u-compact">${esc(task.title)}</span>
          <div class="task-card__meta">
            ${archived ? `<span class="due-date task-card__archived"><i data-lucide="archive" class="icon-sm" aria-hidden="true"></i>${t('tasks.statusArchived')}</span>` : ''}
            ${renderPriorityBadge(task.priority)}
            ${task.due_date ? '' : renderStartDateBadge(task.start_date)}
            ${renderDueDate(task.due_date, task.due_time, isDone || archived)}
            ${/* `role="img"`, sonst wertet keine Hilfstechnik das `aria-label` aus:
                an einem generischen <span> ohne Rolle ist es wirkungslos. Solange
                die Ziffer noch danebenstand, las der Screenreader wenigstens sie -
                seit der Dichte-Runde traegt das Label die Anzahl allein. Dieselbe
                Marke im Budget (budget.js, `.budget-recur-mark`) macht es richtig;
                hier standen zwei Kopien ohne Rolle (PR-Review #754). */ ''}
            ${task.is_recurring ? `<span class="due-date" role="img" aria-label="${esc(t('tasks.recurring'))}"><i data-lucide="repeat" class="icon-sm" aria-hidden="true"></i></span>` : ''}
            ${task.document_count > 0 ? `<span class="due-date task-card__docs" role="img" aria-label="${esc(t('tasks.documentsCount', { count: task.document_count }))}"><i data-lucide="paperclip" class="icon-sm" aria-hidden="true"></i></span>` : ''}
            ${task.locked ? `<span class="due-date" role="img" aria-label="${esc(t('tasks.lockedBadge'))}" title="${esc(t('tasks.lockedBadge'))}"><i data-lucide="lock" class="icon-sm" aria-hidden="true"></i></span>` : ''}
            ${renderVisibilityBadge(task.visibility)}
            ${showCategory && task.category !== FALLBACK_CATEGORY ? `<span class="due-date task-card__category">${esc(catLabel(task.category))}</span>` : ''}
            ${task.activity_assignment_state === 'open' ? '<span class="due-date task-card__category">Open · claimable</span>' : ''}
            ${task.activity_assignment_state === 'unavailable' ? '<span class="due-date task-card__category">Needs an eligible person</span>' : ''}
            ${(task.activity_responsibilities || []).filter((row) => ['beneficiary', 'supervisor'].includes(row.role)).map((row) => `<span class="due-date">${esc(row.role)}: ${esc(row.display_name)}</span>`).join('')}
            ${task.location ? `<span class="due-date task-card__location" title="${esc(task.location.address || task.location.label || '')}"><i data-lucide="map-pin" class="icon-sm" aria-hidden="true"></i>${esc(task.location.label || task.location.address || 'Location')}</span>` : ''}
            ${renderTagBadges(task.tags, ROW_TAG_BADGES_VISIBLE, task.priority)}
          </div>
        </div>

        ${renderAvatarStack(task.assigned_users ?? [], { size: 28 })}

        ${task.activity_assignment_state === 'open' ? `<button class="btn btn--primary btn--sm" data-action="claim-activity" data-id="${task.id}">Claim</button>` : ''}

        ${canEdit && !(task.subtask_total > 0) && !archived && !task.parent_task_id ? `
        <button class="btn btn--ghost btn--icon btn--icon-sm task-card__inline-action task-card__add-subtask" data-action="add-subtask" data-parent="${task.id}"
                aria-label="${t('tasks.subtaskAdd')}" title="${t('tasks.subtaskAdd')}">
          <i data-lucide="list-plus" class="icon-md" aria-hidden="true"></i>
        </button>` : ''}
        ${canEdit ? `
        <button class="btn btn--ghost btn--icon btn--icon-sm task-card__inline-action"
                data-action="${archived ? 'unarchive-task' : 'archive-task'}" data-id="${task.id}"
                aria-label="${archived ? t('tasks.unarchiveButton') : t('tasks.archiveButton')}"
                title="${archived ? t('tasks.unarchiveButton') : t('tasks.archiveButton')}">
          <i data-lucide="${archived ? 'archive-restore' : 'archive'}" class="icon-md" aria-hidden="true"></i>
        </button>` : ''}
      </div>

      ${progress !== null ? `
        <button type="button" class="subtask-progress" data-action="toggle-subtasks" data-id="${task.id}"
                aria-expanded="${expandedSubtasks ? 'true' : 'false'}" aria-controls="subtasks-${task.id}"
                aria-label="${t('tasks.subtaskToggle')}">
          <div class="subtask-progress__bar-wrap">
            <div class="subtask-progress__bar-fill" style="--progress-scale:${progress / 100}"></div>
          </div>
          <span class="subtask-progress__text">${task.subtask_done}/${task.subtask_total}</span>
        </button>` : ''}

      ${task.subtasks?.length ? `
        <div class="subtask-list ${expandedSubtasks ? 'subtask-list--visible' : ''}"
             id="subtasks-${task.id}">
          ${subtasksHtml}
          <button class="subtask-item__add" data-action="add-subtask" data-parent="${task.id}">
            ${t('tasks.subtaskAdd')}
          </button>
        </div>` : ''}
    </div>`;
}

// Effektive Fälligkeit: mit due_time wenn vorhanden, sonst 23:59:59 des Tages
function renderResponsiveTagBadges(task) {
  let tags = [...(task.tags || [])];
  const priority = task.priority && task.priority !== 'none' ? PRIORITY_LABELS()[task.priority] : null;
  if (priority) {
    const normalized = String(priority).trim().toLocaleLowerCase();
    tags = tags.filter((tag) => String(tag).trim().toLocaleLowerCase() !== normalized);
  }
  if (!tags.length) return '';
  return `<div class="activity-card__tags" data-responsive-tags>
    ${tags.map((tag) => `<button type="button" class="task-tag task-tag--filter" data-responsive-tag
      data-tag-filter="${esc(tag)}" title="${esc(tag)}"
      aria-label="${esc(t('tasks.tagFilterBy', { tag }))}">${esc(tag)}</button>`).join('')}
    <span class="task-tag task-tag--more" data-tag-overflow hidden></span>
  </div>`;
}

function renderProfileAvatarButton(participant, size = 34) {
  if (!participant?.id) return '';
  const name = participant.display_name || t('tasks.filterGroupPerson');
  return `<button type="button" class="activity-card__participant-profile" data-action="show-participant-profile"
    data-user-id="${Number(participant.id)}" aria-haspopup="dialog" aria-label="${esc(name)}" title="${esc(name)}">
    ${renderAvatarStack([participant], { size, maxVisible: 1 })}
  </button>`;
}

function renderParticipantStrip(task, participants) {
  if (!participants.length) return '';
  return `<div class="activity-card__participants" aria-label="${esc(t('tasks.participantsLabel'))}">
    ${participants.map((participant) => `<div class="activity-card__participant">
      ${renderProfileAvatarButton(participant, 34)}
      <span class="activity-card__participant-progress">${esc(progressLabel(participantCompletion(task, participant.id)))}</span>
    </div>`).join('')}
  </div>`;
}

function renderActivitySubtasks(task, expanded) {
  const subtasks = task.subtasks || [];
  if (!subtasks.length) return '';
  const done = subtasks.filter((subtask) => subtask.status === 'done').length;
  const rows = subtasks.map((subtask) => {
    const assignees = subtaskParticipants(subtask);
    return `<div class="subtask-item ${subtask.status === 'done' ? 'subtask-item--done' : ''}" data-subtask-id="${subtask.id}">
      <button class="subtask-item__checkbox ${subtask.status === 'done' ? 'subtask-item__checkbox--done' : ''}"
        data-action="toggle-subtask" data-id="${subtask.id}" data-status="${subtask.status}"
        aria-label="${esc(t('tasks.subtaskMarkDone', { title: subtask.title }))}">
        ${subtask.status === 'done' ? '<i data-lucide="check" class="subtask-item__checkbox-icon" aria-hidden="true"></i>' : ''}
      </button>
      <button type="button" class="subtask-item__title" data-action="open-task" data-id="${subtask.id}">${esc(subtask.title)}</button>
      <span class="subtask-item__points">${esc(t('tasks.pointsSummary', { count: Number(subtask.points || 0) }))}</span>
      ${assignees.length ? `<span class="subtask-item__assignees">${assignees.slice(0, 2).map((participant) => renderProfileAvatarButton(participant, 26)).join('')}
        ${assignees.length > 2 ? `<span class="avatar-stack__item avatar-stack__overflow" title="${assignees.length - 2} ${esc(t('userMultiSelect.moreUsers'))}">+${assignees.length - 2}</span>` : ''}</span>` : ''}
    </div>`;
  }).join('');
  return `<div class="activity-card__subtasks">
    <button type="button" class="activity-card__subtasks-toggle" data-action="toggle-subtasks" data-id="${task.id}"
      aria-expanded="${expanded}" aria-controls="subtasks-${task.id}">
      <i data-lucide="chevron-right" class="activity-card__chevron${expanded ? ' activity-card__chevron--open' : ''}" aria-hidden="true"></i>
      <span>${esc(t('tasks.subtasksLabel'))}</span>
      <span class="activity-card__subtasks-progress">${esc(t('tasks.subtaskProgress', { done, total: subtasks.length }))}</span>
    </button>
    <div class="subtask-list${expanded ? ' subtask-list--visible' : ''}" id="subtasks-${task.id}">${rows}</div>
  </div>`;
}

function renderTaskCard(task, opts = {}) {
  const {
    expandedSubtasks = isSubtasksExpanded(task.id),
    showCheckbox = false,
    isChecked = false,
    showCategory = true,
    board = false,
  } = opts;
  const isDone = task.status === 'done';
  const archived = isArchived(task);
  const participants = taskParticipants(task);
  const detailsExpanded = state.expandedTasks.has(Number(task.id));
  const hasDetails = !!String(task.description || '').trim() || participants.length > 0;
  const due = formatDueDate(task.due_date, task.due_time, isDone || archived);
  const location = taskLocationLabel(task);

  return `<article class="task-card activity-card${board ? ' kanban-card' : ''}${isDone ? ' task-card--done kanban-card--done' : ''}${archived ? ' task-card--archived' : ''}"
      data-task-id="${task.id}"${board ? ' draggable="true"' : ''}>
    <div class="activity-card__summary">
      <span class="activity-card__leading">
        ${showCheckbox ? `<input type="checkbox" class="task-bulk-checkbox" data-task-id="${task.id}" ${isChecked ? 'checked' : ''}
          aria-label="${esc(t('tasks.selectTask'))}">` : ''}
        ${hasDetails ? `<button type="button" class="activity-card__details-toggle" data-action="toggle-activity-details" data-id="${task.id}"
          aria-expanded="${detailsExpanded}" aria-controls="activity-details-${task.id}" aria-label="${esc(t('tasks.activityDetailsToggle'))}">
          <i data-lucide="chevron-right" class="activity-card__chevron${detailsExpanded ? ' activity-card__chevron--open' : ''}" aria-hidden="true"></i>
        </button>` : '<span class="activity-card__leading-spacer" aria-hidden="true"></span>'}
      </span>
      <button type="button" class="activity-card__open" data-action="open-task" data-id="${task.id}">
        <span class="activity-card__title u-card-title u-compact">${esc(task.title)}</span>
        <span class="activity-card__when">
          ${due ? `<span class="due-date ${due.cls}"><i data-lucide="clock" class="icon-sm" aria-hidden="true"></i>${esc(due.label)}</span>` : (renderStartDateBadge(task.start_date) || '')}
          ${location ? `<span class="due-date activity-card__location" title="${esc(task.location?.address || location)}"><i data-lucide="map-pin" class="icon-sm" aria-hidden="true"></i>${esc(location)}</span>` : ''}
        </span>
      </button>
      <span class="activity-card__points">${esc(t('tasks.pointsSummary', { count: Number(task.points || 0) }))}</span>
      <button type="button" class="task-status-btn task-status-btn--${task.status}" data-action="toggle-status" data-id="${task.id}" data-status="${task.status}"
        aria-label="${esc(isDone ? t('tasks.markOpen', { title: task.title }) : t('tasks.markDone', { title: task.title }))}">
        <i data-lucide="check" class="task-status-btn__check" aria-hidden="true"></i>
      </button>
    </div>

    ${detailsExpanded && hasDetails ? `<div class="activity-card__details" id="activity-details-${task.id}">
      ${task.description ? `<div class="activity-card__description">${renderMarkdownLight(task.description)}</div>` : ''}
      ${renderParticipantStrip(task, participants)}
    </div>` : ''}

    <div class="activity-card__metadata">
      ${renderPriorityBadge(task.priority)}
      ${showCategory && task.category !== FALLBACK_CATEGORY ? `<span class="due-date activity-card__category">${esc(catLabel(task.category))}</span>` : ''}
      ${task.is_recurring ? `<span class="due-date" title="${esc(t('tasks.recurring'))}"><i data-lucide="repeat" class="icon-sm" aria-hidden="true"></i></span>` : ''}
      ${task.locked ? `<span class="due-date" title="${esc(t('tasks.lockedBadge'))}"><i data-lucide="lock" class="icon-sm" aria-hidden="true"></i></span>` : ''}
      ${renderVisibilityBadge(task.visibility)}
      ${task.activity_assignment_state === 'open' ? `<button class="btn btn--primary btn--sm" data-action="claim-activity" data-id="${task.id}">${esc(t('tasks.claimTask'))}</button>` : ''}
    </div>
    ${renderResponsiveTagBadges(task)}
    ${renderActivitySubtasks(task, expandedSubtasks)}
  </article>`;
}

function wireResponsiveTaskTags(root) {
  state.tagResizeObserver?.disconnect();
  const rows = [...root.querySelectorAll('[data-responsive-tags]')];
  const fit = (row) => {
    const tags = [...row.querySelectorAll('[data-responsive-tag]')];
    const overflow = row.querySelector('[data-tag-overflow]');
    if (!overflow || !tags.length) return;
    tags.forEach((tag) => { tag.hidden = false; });
    overflow.hidden = false;
    overflow.textContent = `+${tags.length}`;
    const style = getComputedStyle(row);
    const gap = Number.parseFloat(style.columnGap || style.gap) || 0;
    const available = row.clientWidth;
    const maximum = available < 280 ? 2 : available < 420 ? 3 : available < 620 ? 4 : 6;
    const overflowWidth = overflow.getBoundingClientRect().width;
    let used = 0;
    let shown = 0;
    for (const [index, tag] of tags.entries()) {
      const width = tag.getBoundingClientRect().width;
      const remainingAfter = tags.length - index - 1;
      const needsOverflow = remainingAfter > 0 || index + 1 > maximum;
      const next = used + (shown ? gap : 0) + width + (needsOverflow ? gap + overflowWidth : 0);
      if (shown < maximum && (next <= available || shown === 0)) {
        used += (shown ? gap : 0) + width;
        shown++;
      } else {
        tag.hidden = true;
      }
    }
    const hidden = tags.length - shown;
    overflow.hidden = hidden === 0;
    overflow.textContent = `+${hidden}`;
    overflow.title = hidden ? tags.slice(shown).map((tag) => tag.textContent.trim()).join(', ') : '';
  };
  rows.forEach(fit);
  if (typeof ResizeObserver === 'function') {
    state.tagResizeObserver = new ResizeObserver((entries) => entries.forEach((entry) => fit(entry.target)));
    rows.forEach((row) => state.tagResizeObserver.observe(row));
  } else {
    state.tagResizeObserver = null;
  }
}

function effectiveDue(task) {
  if (!task.due_date) return null;
  return task.due_time
    ? new Date(`${task.due_date}T${task.due_time}`)
    : new Date(`${task.due_date}T23:59:59`);
}

// Einheitliche Sortierung: überfällig zuerst → Datum/Zeit ASC → Prio als Tiebreaker
function sortTasks(a, b, now) {
  const aDate = effectiveDue(a);
  const bDate = effectiveDue(b);
  const aOver = aDate && aDate < now ? 1 : 0;
  const bOver = bDate && bDate < now ? 1 : 0;
  if (bOver !== aOver) return bOver - aOver;
  if (!aDate && !bDate) return (PRIO_ORDER[a.priority] ?? 4) - (PRIO_ORDER[b.priority] ?? 4);
  if (!aDate) return 1;
  if (!bDate) return -1;
  if (aDate.getTime() !== bDate.getTime()) return aDate < bDate ? -1 : 1;
  return (PRIO_ORDER[a.priority] ?? 4) - (PRIO_ORDER[b.priority] ?? 4);
}

function renderTaskGroups(tasks, groupMode) {
  if (!tasks.length) {
    // Leere Suche ≠ leeres Modul: bei aktiver Suche wäre „Noch keine Aufgaben"
    // schlicht falsch und der Anlegen-CTA die falsche Antwort (Notizen-Muster).
    const isFiltered = state.searchQuery.trim().length > 0;
    // Der Suchbegriff geht ROH in den Renderer: der escapt selbst. Vorher stand
    // hier ein `esc()` vor der Uebergabe, weil das Ergebnis in ein
    // Template-Literal floss - ueber den Renderer waere daraus eine zweite
    // Maskierung geworden und „a&b" haette als „a&amp;b" auf dem Schirm gestanden.
    return isFiltered
      ? emptyStateHTML({
        variant: 'no-results',
        title: t('tasks.noResultsTitle'),
        description: t('tasks.noResultsDescription', { query: state.searchQuery }),
      })
      : emptyStateHTML({
        icon: 'circle-check-big',
        title: t('tasks.emptyTitle'),
        description: t('tasks.emptyDescription'),
        hint: t('emptyHint.tasks'),
        action: { label: t('tasks.emptyAction'), icon: 'plus', attrs: { id: 'empty-cta-tasks' } },
      });
  }

  const groups = taskBuckets(tasks, groupMode);
  return groups.map(({ id, label, tasks: groupTasks }) => {
    const sorted = sortedTasks(groupTasks, `list:${groupMode}:${id}`);
    const collapsed = isGroupCollapsed(groupMode, id);
    return `
    <div class="task-group list-group">
      <!-- Gruppenkopf als echte Ueberschrift (Critique 2026-08-10): /tasks
           hatte genau EIN h-Element im ganzen Dokument, und wer per H-Taste
           navigiert, kam damit auf den Seitentitel und nicht weiter. Der
           Seitentitel ist h1, die Gruppe darunter also h2.

           Die FORM kommt seit der Zusammenfuehrung aus der geteilten
           Gruppen-Grammatik (styles/list-row.css), wie im Einkauf und im
           Vorrat: Label und Zaehlstand stehen NEBENEINANDER. Vorher trug der
           Kopf ein eigenes space-between und schob die Zahl an die rechte
           Traegerkante - auf 1280px stand sie damit 640px vom Gruppennamen
           entfernt und las sich als unverbundener Wert. Genau diesen Befund
           hatte der Einkauf am 2026-07-30 schon einmal. -->
      <h2 class="list-group__title">
        <!-- Der Kopf ist ein Knopf, keine anklickbare Ueberschrift (#812): nur
             so kennt ihn die Tastatur, und nur so kann aria-expanded den
             Zustand ueberhaupt melden. -->
        <button type="button" class="list-group__toggle" data-group-toggle="${esc(id)}"
                aria-expanded="${collapsed ? 'false' : 'true'}">
          <i data-lucide="chevron-down" aria-hidden="true"
             class="list-group__chevron${collapsed ? ' list-group__chevron--collapsed' : ''}"></i>
          <span>${esc(label)}</span>
        </button>
        <span class="list-group__count">${groupTasks.length}</span>
      </h2>
      ${collapsed ? '' : `<div class="list-rows">
        ${sorted.map((t) => renderSwipeRow(t, renderTaskCard(t, {
          showCheckbox: state.bulkSelectMode,
          isChecked: state.selectedTaskIds.has(t.id),
          expandedSubtasks: isSubtasksExpanded(t.id),
          showCategory: groupMode !== 'category',
        }))).join('')}
      </div>`}
    </div>`;
  }).join('');
}

// --------------------------------------------------------
// Task-Modal (Erstellen / Bearbeiten)
// --------------------------------------------------------

// --------------------------------------------------------
// Tags (#586)
// Freie Etiketten, gespiegelt aus VTODO CATEGORIES. Bewusst getrennt von der
// Kategorie: eine Aufgabe liegt in einer Schublade, trägt aber beliebig viele
// Etiketten.
// --------------------------------------------------------
// Working-Set des offenen Bearbeiten-Dialogs, analog zu den verknüpften
// Dokumenten. Wird beim Öffnen aus der Aufgabe gefüllt und beim Speichern gelesen.
let modalTags = [];
/** Zeichnet die Chips des Tag-Editors neu. */
function renderTagChips(container) {
  const wrap = container.querySelector('#task-tags-chips');
  if (!wrap) return;
  wrap.replaceChildren();

  modalTags.forEach((tag, index) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'task-tag task-tag--editable';
    chip.dataset.tagIndex = String(index);
    chip.setAttribute('aria-label', t('tasks.tagRemove', { tag }));
    chip.appendChild(document.createTextNode(tag));

    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'x');
    icon.className = 'icon-sm';
    icon.setAttribute('aria-hidden', 'true');
    chip.appendChild(icon);

    wrap.appendChild(chip);
  });

  if (window.lucide) window.lucide.createIcons({ el: wrap });
}

/**
 * Verdrahtet den Tag-Editor: Enter oder Komma übernimmt, Klick auf ein Chip
 * entfernt, Backspace im leeren Feld nimmt das letzte zurück.
 */
function wireTagEditor(panel) {
  const input = panel.querySelector('#task-tag-input');
  const chips = panel.querySelector('#task-tags-chips');
  if (!input || !chips) return;

  const commit = () => {
    // Eine eingefügte Liste („Garten, Haus") in einem Rutsch übernehmen.
    const added = input.value.split(',');
    if (!added.some((v) => v.trim())) return;
    modalTags = normalizeTagList([...modalTags, ...added]);
    input.value = '';
    renderTagChips(panel);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      // Enter darf im Tag-Feld nicht das Formular abschicken.
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === 'Backspace' && !input.value && modalTags.length) {
      modalTags = modalTags.slice(0, -1);
      renderTagChips(panel);
    }
  });

  // Verlassen des Feldes übernimmt ebenfalls: sonst geht ein getippter Tag beim
  // Speichern still verloren.
  input.addEventListener('blur', commit);
  // Auswahl aus der Vorschlagsliste löst kein keydown aus.
  input.addEventListener('change', commit);

  chips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-tag-index]');
    if (!chip) return;
    modalTags.splice(Number(chip.dataset.tagIndex), 1);
    renderTagChips(panel);
  });
}

// Wie viele Tags eine Karte zeigt, bevor sie zusammenfasst. Analog zum
// Avatar-Stack: eine Karte, die 32 Etiketten ausrollt, ist keine Karte mehr.
const TAG_BADGES_VISIBLE = 3;

/* In der LISTENZEILE steht genau ein Etikett, im Kanban bleiben es drei: dort
 * ist die Karte die ganze Darstellung der Aufgabe und hat die Höhe dafür, hier
 * teilt sich das Etikett die Zeile mit Priorität, Fälligkeit und Avatar. */
const ROW_TAG_BADGES_VISIBLE = 1;

/**
 * Tag-Chips einer Aufgabe für Karten und Kanban.
 *
 * Die Chips sind Buttons, keine Beschriftungen: ein Tag anzuklicken und die
 * Liste darauf zu filtern ist die Geste, die man von einem Etikett erwartet.
 * Den Klick fängt die Delegation in wireTagBadgeFilter ab, die ihn auch vom
 * Karten-Klick (Aufgabe öffnen) trennt.
 */
/**
 * @param {string} [priority]  Die Priorität der Aufgabe, deren Etiketten das
 *   hier sind. Ein Etikett, das GENAU SO heisst wie sie, wird weggelassen.
 *
 * WARUM: gemessen stand auf /tasks der Prioritäts-Chip „• Dringend" direkt
 * neben dem gespiegelten CalDAV-Etikett „dringend" - zwei Formen, dasselbe
 * Wort, in einer Metazeile, die seit dem Zeilenschnitt einzeilig ist und jedes
 * Element bezahlt. Beide kommen aus derselben Quelle: eine VTODO trägt ihre
 * Dringlichkeit als PRIORITY und noch einmal als CATEGORIES.
 *
 * NUR DIE EIGENE PRIORITÄT, nicht jedes Prioritätswort: trägt eine Aufgabe mit
 * Priorität „hoch" ein Etikett „dringend", ist das keine Doppelung, sondern ein
 * Widerspruch - und den soll man sehen.
 *
 * Verglichen wird gegen das ANGEZEIGTE Label, nicht gegen den Schlüssel: das
 * Etikett kommt aus einer fremden Liste und ist in der Sprache geschrieben, in
 * der der Nutzer es dort angelegt hat.
 */
function renderTagBadges(tags, limit = TAG_BADGES_VISIBLE, priority = null) {
  if (!tags?.length) return '';
  const eigenes = priority && priority !== 'none' ? PRIORITY_LABELS()[priority] : null;
  if (eigenes) {
    const norm = (s) => String(s).trim().toLocaleLowerCase();
    tags = tags.filter((tag) => norm(tag) !== norm(eigenes));
    if (!tags.length) return '';
  }
  const shown = tags.slice(0, limit);
  const rest  = tags.length - shown.length;
  const chips = shown.map((tag) => `
    <button type="button" class="task-tag task-tag--filter" data-tag-filter="${esc(tag)}"
            aria-label="${esc(t('tasks.tagFilterBy', { tag }))}">${esc(tag)}</button>`);
  // Der Rest bleibt lesbar statt anklickbar: er benennt keinen einzelnen Tag,
  // also gäbe es auch nichts, worauf ein Klick filtern könnte.
  if (rest > 0) {
    chips.push(`<span class="task-tag task-tag--more"
                      title="${esc(tags.slice(limit).join(', '))}">+${rest}</span>`);
  }
  return chips.join('');
}

/**
 * Klick auf ein Tag-Chip filtert die Liste danach (#586).
 *
 * Delegiert, weil Karten laufend neu gezeichnet werden - und in der
 * Capture-Phase, nicht beim Bubbling. Im Kanban öffnet ein Klick irgendwo auf
 * der Karte den Bearbeiten-Dialog, und dieser Handler sitzt am Board, also
 * unterhalb des Containers: beim Bubbling käme er zuerst dran und hätte den
 * Dialog längst geöffnet, bevor ein stopPropagation hier noch etwas ausrichtet.
 */
function wireTagBadgeFilter(container) {
  container.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-tag-filter]');
    if (!chip || !container.contains(chip)) return;
    e.preventDefault();
    e.stopPropagation();
    await toggleTagFilter(chip.dataset.tagFilter, container);
  }, true);

  // Gruppenkopf auf- und zuklappen (#812).
  container.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-group-toggle]');
    if (!toggle || !container.contains(toggle)) return;
    toggleGroup(state.groupMode, toggle.dataset.groupToggle);
    renderTaskList(container);
  });
}

function renderModalContent({ task = null, users = [], reminder = null, presetActivityTemplate = null, presetDates = null } = {}) {
  const isEdit = !!task;
  const presetStartDate = isEdit ? task?.start_date : (presetDates?.start_date || null);
  const presetDueDate = isEdit ? task?.due_date : (presetDates?.due_date || null);

  const selectedIds = task?.assigned_users?.map((u) => u.id) ?? (task?.assigned_to ? [task.assigned_to] : []);
  const rotationIds = task?.rotation_user_ids ?? [];
  const assignmentMode = task?.assignment_mode || 'fixed';
  const rotationGroup = task?.rotation_group || '';
  const rotationPosition = Number(task?.rotation_slot ?? 0) + 1;
  const visibility  = task?.visibility || 'all';
  const activityTemplateId = task?.activity_template_id
    ? Number(task.activity_template_id)
    : (presetActivityTemplate?.id ? Number(presetActivityTemplate.id) : null);
  const activitySubjectUserId = task?.activity_subject_user_id ? Number(task.activity_subject_user_id) : null;
  const activityTemplates = [...(state.activityTemplates ?? [])];
  if (activityTemplateId && !activityTemplates.some((item) => Number(item.id) === activityTemplateId)) {
    activityTemplates.push({
      id: activityTemplateId,
      name: task?.activity_template_name || `Activity ${activityTemplateId}`,
      subject_required: task?.activity_subject_required ? 1 : 0,
      inactive: true,
    });
  }
  const activityOptions = activityTemplates.map((activity) =>
    `<option value="${activity.id}" data-subject-required="${activity.subject_required ? '1' : '0'}" ${activityTemplateId === Number(activity.id) ? 'selected' : ''}>${esc(activity.name)}${activity.inactive ? ' (inactive)' : ''}</option>`
  ).join('');
  const activitySubjectOptions = users.map((user) =>
    `<option value="${user.id}" ${activitySubjectUserId === Number(user.id) ? 'selected' : ''}>${esc(user.display_name)}</option>`
  ).join('');

  const selectedCat = task?.category ?? presetActivityTemplate?.category ?? FALLBACK_CATEGORY;
  const categoryOptions = state.categories.map((c) =>
    `<option value="${esc(c.key)}" ${selectedCat === c.key ? 'selected' : ''}>${esc(catLabel(c.key))}</option>`
  ).join('');

  const priorityOptions = PRIORITIES().map((p) =>
    `<option value="${p.value}" ${(task?.priority ?? 'none') === p.value ? 'selected' : ''}>${p.label}</option>`
  ).join('');

  // Punkte neuer Aufgaben mit dem Haushalt-Standard vorbelegen (#578).
  const prefillPoints = !isEdit && state.defaultPoints > 0 ? state.defaultPoints : 0;
  const pointsValue = isEdit
    ? (Number(task?.points) > 0 ? Number(task.points) : '')
    : (prefillPoints || '');

  /* WAS IN DER SEKTION STEHT, NENNT IHRE ZUSAMMENFASSUNG - dann muss sie nicht
   * auf (Critique 2026-08-10, P1 „Enterprise-SaaS-Antireferenz").
   *
   * Das Formular mass 29 Labels und `scrollHeight 1410` in `clientHeight 528`,
   * also 2,7 Bildschirme, um eine Aufgabe zu aendern - die haeufigste Handlung
   * der App auf ihrem ueberladensten Screen. Die progressive Offenlegung war
   * dabei nicht etwa nicht gebaut: sie war gebaut und abgeschaltet, und der
   * Schalter war diese eine Zeile.
   *
   * `advancedFieldsOpen` verlangte „einen Wert abseits der Defaults", zaehlte
   * dazu aber `category !== FALLBACK_CATEGORY`. Eine Kategorie hat fast jede
   * Aufgabe - die Bedingung war also praktisch immer wahr, und die Sektion kam
   * praktisch immer offen. Eine Regel, die jeden Fall zur Ausnahme erklaert,
   * hat keine Ausnahme mehr.
   *
   * Der Grund hinter der Bedingung war richtig: ein gesetzter Wert darf nicht
   * unsichtbar sein. Nur ist Aufklappen dafuer die teuerste Antwort. Das Muster
   * fuer die billige stand schon zwei Zeilen weiter unten - bei den
   * vorbelegten Punkten, wo der Aufklapper ZU blieb und die Zusammenfassung den
   * Wert nannte. Es gilt jetzt fuer alle Sekundaerfelder.
   *
   * Die Beschreibung traegt die Zusammenfassung nicht: sie ist Freitext, und
   * eine gekuerzte Notiz im Summary waere eine schlechtere Notiz. Sie steht
   * deshalb OBEN beim Titel - Titel und Notiz sichtbar, alles andere hinter
   * einem Einstieg, genau wie Apple Erinnerungen es haelt. */
  const advancedSummary = [];
  if (isEdit && task.priority && task.priority !== 'none') {
    advancedSummary.push(PRIORITY_LABELS()[task.priority] ?? task.priority);
  }
  if (isEdit && task.category && task.category !== FALLBACK_CATEGORY) {
    advancedSummary.push(catLabel(task.category));
  }
  if (presetStartDate) advancedSummary.push(formatDate(presetStartDate));
  const summaryPoints = isEdit ? Number(task.points) : prefillPoints;
  if (summaryPoints > 0) advancedSummary.push(t('tasks.pointsSummary', { count: summaryPoints }));
  if (isEdit && task.tags?.length) advancedSummary.push(task.tags.join(', '));

  const advancedLabel = advancedSummary.length
    ? `${t('modal.moreSettings')} · ${advancedSummary.join(' · ')}`
    : undefined;

  const advancedFieldsHtml = `
      <div class="modal-grid modal-grid--2">
        <div class="form-group">
          <label class="label" for="task-priority">${t('tasks.priorityLabel')}</label>
          <select class="input" id="task-priority" name="priority">
            ${priorityOptions}
          </select>
        </div>
        <div class="form-group">
          <label class="label" for="task-category">${t('tasks.categoryLabel')}</label>
          <select class="input" id="task-category" name="category">
            ${categoryOptions}
          </select>
        </div>
      </div>

      <div class="modal-grid modal-grid--2" style="margin-top:var(--space-4)">
        <div class="form-group">
          <label class="label" for="task-start-date">${t('tasks.startDateLabel')}</label>
          <yuvomi-datepicker type="date" id="task-start-date" name="start_date"
                 value="${esc(formatDateInput(presetStartDate))}"></yuvomi-datepicker>
        </div>
        <div class="form-group">
          <label class="label" for="task-points">${t('tasks.pointsLabel')}</label>
          <input class="input" type="number" id="task-points" name="points" inputmode="numeric"
                 min="0" step="1" value="${pointsValue}"
                 placeholder="0">
          <p class="task-field-hint">${prefillPoints
            ? t('tasks.pointsDefaultHint', { count: prefillPoints })
            : t('tasks.pointsHint')}</p>
        </div>
      </div>

      <div class="form-group task-tags-field" style="margin-top:var(--space-4)">
        <label class="label" for="task-tag-input">${t('tasks.tagsLabel')}</label>
        <div class="task-tags-editor" id="task-tags-editor">
          <div class="task-tags-editor__chips" id="task-tags-chips"></div>
          <input class="input task-tags-editor__input" type="text" id="task-tag-input"
                 list="task-tag-suggestions" autocomplete="off"
                 placeholder="${t('tasks.tagsPlaceholder')}">
          <datalist id="task-tag-suggestions">
            ${state.allTags.map((entry) => `<option value="${esc(entry.tag)}"></option>`).join('')}
          </datalist>
        </div>
        <p class="task-field-hint">${t('tasks.tagsHint')}</p>
      </div>`;

  return `
    <form id="task-form" novalidate>
      <input type="hidden" id="task-id" value="${task?.id ?? ''}">

      <div class="form-group task-template-picker">
        <label class="label" for="task-activity-template">Start from an Activity Template</label>
        <select class="input" id="task-activity-template" name="activity_template_id">
          <option value="">Blank task</option>
          ${activityOptions}
        </select>
        <p class="task-field-hint">Templates fill the task instructions and use saved skills and proficiency to choose an assignee.</p>
      </div>

      <div class="form-group" id="task-activity-subject" hidden>
        <label class="label" for="task-activity-subject-user">Who is this activity for?</label>
        <select class="input" id="task-activity-subject-user" name="activity_subject_user_id">
          <option value="">Choose a household member</option>
          ${activitySubjectOptions}
        </select>
        <p class="task-field-hint">The template can use this person in its title and proficiency rules.</p>
      </div>

      ${isEdit && task?.activity_template_id ? `<section class="form-group">
        <label class="label">Activity responsibility</label>
        <p class="task-field-hint">${(task.activity_responsibilities || []).map((row) => `${esc(row.role)}: ${esc(row.display_name)}`).join(' · ') || (task.activity_assignment_state === 'open' ? 'Open for an eligible household member to claim.' : 'No active responsibility recorded.')}</p>
        ${state.isAdmin && task.activity_assignment_override_allowed ? `<div class="modal-grid modal-grid--2"><select class="input" data-activity-reassign>${users.map((user) => `<option value="${user.id}" ${Number(user.id) === Number(task.assigned_to) ? 'selected' : ''}>${esc(user.display_name)}</option>`).join('')}</select><button class="btn btn--secondary" type="button" data-activity-reassign-submit data-task-id="${task.id}">Reassign safely</button></div><p class="task-field-hint">Yuvomi will recheck skills, age limits, availability, and presence before changing the assignment.</p>` : ''}
      </section>` : ''}

      <div class="form-group">
        <div class="form-field">
          <label class="label" for="task-title">${t('tasks.titleLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
          <input class="input" type="text" id="task-title" name="title"
                 value="${esc(task?.title ?? presetActivityTemplate?.title_template ?? presetActivityTemplate?.name ?? '')}" placeholder="${t('tasks.titlePlaceholder')}"
                 required autocomplete="off">
          <div class="form-field__error">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/>
                 <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16.01"/>
            </svg>
            ${t('common.required')}
          </div>
        </div>
      </div>

      <!-- Notiz steht beim Titel, nicht hinter dem Aufklapper: sie ist sein
           Gegenstueck, und eine Zusammenfassung kann Freitext nicht tragen.
           Genau deshalb sind zwei Zeilen zu wenig gewesen (#731): das Feld war
           auf die Groesse einer Zusammenfassung gebaut, obwohl der Kommentar
           darueber das Gegenteil begruendet. -->
      <div class="form-group">
        <label class="label" for="task-description">${t('tasks.descriptionLabel')}</label>
        ${renderMarkdownToolbar()}
        <textarea class="input" id="task-description" name="description"
                  rows="6" placeholder="${t('tasks.descriptionPlaceholder')}"
                 >${esc(task?.description ?? presetActivityTemplate?.description ?? '')}</textarea>
        <small class="form-hint">${t('tasks.descriptionMarkdownHint')}</small>
      </div>
      ${renderTaskLocationFields(task)}
${syncTargetFieldHtml(task)}
      <div class="modal-grid modal-grid--2">
        <div class="form-group">
          <label class="label" for="task-due-date">${t('tasks.dueDateLabel')}</label>
          <yuvomi-datepicker type="date" id="task-due-date" name="due_date"
                 value="${esc(formatDateInput(presetDueDate))}"></yuvomi-datepicker>
        </div>
        <div class="form-group">
          <label class="label" for="task-due-time">${t('tasks.dueTimeLabel')}</label>
          <yuvomi-datepicker type="time" id="task-due-time" name="due_time"
                 value="${esc(formatTimeInput(task?.due_time ?? ''))}"></yuvomi-datepicker>
        </div>
      </div>

      <!-- „Zugewiesen an" bot einer Solo-Nutzerin eine Chip-Reihe mit ihr selbst
           und „- Niemand -" (Critique 2026-08-10). Das Feld bleibt im DOM und
           behaelt seinen Wert, es wird nur verborgen - der Absende-Pfad liest
           es unveraendert (utils/household.js). -->
      <div class="form-group" id="task-manual-assignment-mode" style="margin-top:var(--space-4)"${isSoloHousehold() ? ' hidden' : ''}>
        <label class="label" for="task-assignment-mode">Assignment mode</label>
        <select class="input" id="task-assignment-mode" name="assignment_mode">
          <option value="fixed" ${assignmentMode === 'fixed' ? 'selected' : ''}>Fixed</option>
          <option value="round_robin" ${assignmentMode === 'round_robin' ? 'selected' : ''}>Round robin</option>
        </select>
        <p class="task-field-hint">Round robin assigns each recurring occurrence to the next person in the ordered list.</p>
      </div>

      <div id="task-fixed-assignment" class="form-group" style="margin-top:var(--space-4)"${isSoloHousehold() ? ' hidden' : ''}>
        ${renderUserMultiSelect(users, selectedIds, 'task_assigned', 'tasks.assignedLabel')}
      </div>

      <div id="task-round-robin-assignment" class="form-group" style="margin-top:var(--space-4)"${assignmentMode === 'round_robin' && !isSoloHousehold() ? '' : ' hidden'}>
        ${renderUserRotationOrder(users, rotationIds)}
        <div style="margin-top:var(--space-3)">
          <label class="label" for="task-rotation-group">Rotation group <span class="text-muted">(optional)</span></label>
          <input class="input" id="task-rotation-group" name="rotation_group" maxlength="80"
                 value="${esc(rotationGroup)}" placeholder="e.g. Shower order">
          <p class="task-field-hint">Tasks with the same group advance together only after every position in the current cycle is complete.</p>
        </div>
        <div style="margin-top:var(--space-3)">
          <label class="label" for="task-rotation-position">Group position</label>
          <input class="input" id="task-rotation-position" name="rotation_position" type="number" min="1"
                 value="${rotationPosition}">
          <p class="task-field-hint">Position 1 uses the first person, position 2 the second, and so on. Each new cycle shifts all positions by one.</p>
        </div>
      </div>

      <!-- EINE QUELLE, NICHT ZWEI: die Bedingung war "users.length > 1" und
           beantwortete dieselbe Frage wie der Solo-Schalter, nur aus einer
           anderen Zahl - der geladenen Nutzerliste dieses Moduls statt der
           gezaehlten Haushaltsgroesse. Zwei Quellen fuer eine Frage laufen
           auseinander, sobald eine von beiden einen Sonderfall bekommt
           (Split-Gaeste zaehlen in der Nutzerliste mit, im Haushalt nicht).

           UND VERBORGEN, NICHT ENTFERNT - das ist hier kein Stilfrage, sondern
           die Regel selbst. Der Absende-Pfad liest
           "#task-visibility?.value || 'all'" (unten): ohne den Knoten schreibt
           JEDES Speichern im Solo-Haushalt "all" ueber den gespeicherten Wert,
           und eine als "private" angelegte Aufgabe verliert ihre Sichtbarkeit
           stillschweigend. Der Fehler steckte schon in der alten
           users.length-Bedingung; die Solo-Regel sagt ausdruecklich, dass sie
           keine Daten aendert (utils/household.js), also muss der Knoten
           stehenbleiben. Dokumente machen es an ihrer Stelle genauso. --> 
      <div class="form-group" style="margin-top:var(--space-4)"${isSoloHousehold() ? ' hidden' : ''}>
        <label class="label" for="task-visibility">${t('common.visibility.label')}</label>
        <select class="input" id="task-visibility" name="visibility">
          <option value="all"       ${visibility === 'all'       ? 'selected' : ''}>${t('common.visibility.all')}</option>
          <option value="assignees" ${visibility === 'assignees' ? 'selected' : ''}>${t('common.visibility.assignees')}</option>
          <option value="private"   ${visibility === 'private'   ? 'selected' : ''}>${t('common.visibility.private')}</option>
        </select>
        <p class="task-field-hint">${t('common.visibility.hint')}</p>
        <p class="task-field-hint field-hint--warn" id="task-visibility-warning" role="status" hidden><i data-lucide="alert-triangle" aria-hidden="true"></i><span>${t('common.visibility.assigneesNobodyHint')}</span></p>
      </div>

      <!-- #830: Die Sperre steht neben der Sichtbarkeit, weil beide dieselbe
           Frage beantworten - wer darf hier was. Sichtbarkeit regelt das Sehen,
           die Sperre das Aendern. In einem Ein-Personen-Haushalt sagen beide
           nichts, also verschwinden sie zusammen (isSoloHousehold). -->
      <div class="form-group" style="margin-top:var(--space-4)"${isSoloHousehold() ? ' hidden' : ''}>
        <label class="toggle" style="margin:0">
          <input type="checkbox" id="task-locked" name="locked" aria-describedby="task-locked-hint"
                 ${task?.locked ? 'checked' : ''}>
          <span class="toggle__track"></span>
          <span>${t('tasks.lockedToggle')}</span>
        </label>
        <p class="task-field-hint" id="task-locked-hint">${t('tasks.lockedHint')}</p>
      </div>

      <!-- #647: die Haelfte, die @jamespurnama1 beschrieben hat. Fuehrerschein
           und Luftfilter sind keine Termine, und ihre Ruecksetzung haengt an
           einer DAUER, nicht an einem Datum - das ist genau eine wiederkehrende
           Aufgabe „ab Erledigung" (#658), die es hier schon gibt. Der Schalter
           haengt deshalb an der Aufgabe und nicht an einem dritten Objekt.
           Im Hauptbereich aus demselben Grund wie im Kalender: hinter dem
           Aufklapper faende ihn niemand, der nicht danach sucht. -->
      <div class="form-group" style="margin-top:var(--space-4)">
        <label class="toggle" style="margin:0">
          <input type="checkbox" id="task-countdown" name="countdown" aria-describedby="task-countdown-hint"
                 ${task?.countdown ? 'checked' : ''}>
          <span class="toggle__track"></span>
          <span>${t('tasks.countdownToggle')}</span>
        </label>
        <p class="task-field-hint" id="task-countdown-hint">${t('tasks.countdownHint')}</p>
        <!-- DER SCHALTER SPERRT SICH SELBST, statt sich auf die Zeile darueber
             zu verlassen. Ein Hinweis ist keine Fehlervermeidung: ohne
             Faelligkeit war der Schalter voll bedienbar, speicherte, meldete
             „Aufgabe erstellt." - und der Countdown erschien nie. Wer sich
             darauf verlaesst, erfaehrt es, wenn die Frist vorbei ist. -->
        <p class="task-field-hint field-hint--warn" id="task-countdown-warning" role="status" hidden><i data-lucide="alert-triangle" aria-hidden="true"></i><span>${t('tasks.countdownNeedsDue')}</span></p>
      </div>

      ${advancedSection(advancedFieldsHtml, { label: advancedLabel, open: !!(!isEdit && presetStartDate) })}

      ${isEdit ? `
        <div class="form-group">
          <label class="label" for="task-status">${t('tasks.statusLabel')}</label>
          <select class="input" id="task-status" name="status">
            ${STATUSES().map((s) =>
              `<option value="${s.value}" ${task.status === s.value ? 'selected' : ''}>${s.label}</option>`
            ).join('')}
          </select>
        </div>` : ''}

      ${renderRRuleFields('task', task?.recurrence_rule, {
        allowFromCompletion: true,
        fromCompletion: !!task?.recurrence_from_completion,
      })}

      ${renderReminderSection(task, reminder)}

      ${renderDocumentAttachField({
        attachments: (task?.documents ?? []).map((doc) => ({ document_id: doc.id, name: doc.name, mime_type: doc.mime_type })),
        label: t('tasks.documentsLabel'),
      })}

      <div id="task-form-error" class="form-error" hidden></div>

      <div class="modal-panel__footer modal-panel__footer--plain">
        ${isEdit ? `
          <button type="button" class="btn btn--danger-outline" data-action="delete-task"
                  data-id="${task.id}" style="margin-right:auto">${t('common.delete')}</button>` : ''}
        <button type="button" class="btn btn--ghost" data-action="close-modal">${t('common.cancel')}</button>
        <button type="submit" class="btn btn--primary" id="task-submit-btn">
          ${isEdit ? t('common.save') : t('common.create')}
        </button>
      </div>
    </form>`;
}

// --------------------------------------------------------
// Seiten-State
// --------------------------------------------------------

let state = {
  tasks:           [],
  // Das Fehlerobjekt des letzten Ladeversuchs, oder null. Nicht `true`:
  // `mountLoadError` liest daraus den Statuscode.
  loadError:       null,
  // Der angemeldete Nutzer, wie ihn render() bekommt. Gehalten fuer den
  // Wiederholen-Weg des Ladefehlers: aus `currentUserId` allein liesse sich
  // `isAdmin` nicht rekonstruieren, und der Retry haette die Rechte gesenkt.
  user:            null,
  users:           [],
  categories:      [],
  allTags:         [],       // [{ tag, count }] für Filterleiste und Vorschläge (#586)
  defaultPoints:   0,        // Haushalt-Standard für neue Aufgaben (#578), 0 = aus
  activityTemplates: [],
  assignmentRequests: [],
  places: [],
  placeSearchStatus: null,
  currentUserId:   null,
  isAdmin:         false,    // darf fremde Kommentare entfernen (#734)
  // `tags` ist eine Liste, keine Auswahl: mehrere Tags engen UND-verknüpft ein,
  // wie jeder andere Filter in dieser Leiste auch (#586).
  // Status, Priorität und Person halten mehrere Werte (#671); innerhalb einer
  // Achse wirken sie ODER, zwischen den Achsen UND. Tags bleiben UND-verknüpft.
  filters:         { status: ['open'], priority: [], assigned_to: [], tags: [] },
  groupMode:       'category',   // 'category' | 'due'
  viewMode:        'list',       // 'list' | 'kanban' | 'calendar' | 'history'
  boardScope:      'personal',   // personal device board | household hub board
  groupModes:      { list: 'category', personal: 'category', household: 'assignee', calendar: 'category' },
  sheetSort:       { field: 'default', direction: 'asc' },
  bucketSorts:     new Map(),
  progressMode:    'percent',
  // Der Verlauf (#791) hat einen eigenen Bestand, weil er etwas anderes zeigt
  // als `tasks`: nicht Aufgaben, sondern Vorgänge. Er wird geblättert statt
  // gefiltert - deshalb ein Cursor und kein Seitenindex.
  history:         { entries: [], hasMore: false, cursor: null, userId: null, loading: null, error: null },
  showFuture:      false,
  subtasksExpandedByDefault: false,
  // Persönliche Standard-Erinnerungsliste für neue Aufgaben (#695), leer = nur
  // lokal. Wird beim Öffnen des Dialogs als Vorauswahl gesetzt.
  defaultSyncTarget: '',
  expandedTasks:   new Set(),
  expandedSubtasks: new Set(),
  collapsedSubtasks: new Set(),
  collapsedBoardSections: new Set(),
  expandedBoardSections: new Set(),
  tagResizeObserver: null,
  // Eingeklappte Gruppen (#812), als "<modus>:<gruppen-id>" - derselbe Name
  // kann in beiden Gruppierungen vorkommen und meint dort Verschiedenes.
  collapsedGroups: new Set(),
  dragTaskId:      null,
  dragBucketKey:   null,
  filterPanelOpen: false,
  bulkSelectMode:  false,
  selectedTaskIds: new Set(),
  searchQuery:     '',
  calendarCursor:  `${todayKey().slice(0, 7)}-01`,
  calendarFocusDate: todayKey(),
  calendarWeekStart: 1,
  calendarSelection: null,
  calendarPickerYear: parseLocalDateKey(todayKey()).getFullYear(),
  calendarEventsAbort: null,
  calendarShowAllUnscheduled: false,
};

function activeLayoutKey() {
  if (state.viewMode === 'calendar') return 'calendar';
  if (state.viewMode !== 'kanban') return 'list';
  return state.boardScope;
}

function deviceTaskBoardScope() {
  return isWallModeEnabled() ? 'household' : 'personal';
}

function isSubtasksExpanded(taskId) {
  const id = Number(taskId);
  return state.expandedSubtasks.has(id)
    || (state.subtasksExpandedByDefault && !state.collapsedSubtasks.has(id));
}

function syncActiveGroupMode() {
  state.groupMode = state.groupModes[activeLayoutKey()] || 'category';
}

function persistTaskLayoutState() {
  try {
    localStorage.setItem(TASK_GROUP_MODES_KEY, JSON.stringify(state.groupModes));
    localStorage.setItem(TASK_SORT_STATE_KEY, JSON.stringify({
      sheet: state.sheetSort,
      buckets: [...state.bucketSorts.entries()],
    }));
    localStorage.setItem(TASK_PROGRESS_MODE_KEY, state.progressMode);
  } catch {}
}

function loadTaskLayoutState() {
  const groupValues = new Set(GROUP_FIELDS().map((field) => field.value));
  const sortValues = new Set(SORT_FIELDS().map((field) => field.value));
  // Board scope is a device-mode decision, not a Tasks preference. A hub that
  // has Wall mode enabled always receives the household board; every other
  // device receives the personal board.
  state.boardScope = deviceTaskBoardScope();
  try {
    const storedGroups = JSON.parse(localStorage.getItem(TASK_GROUP_MODES_KEY) || '{}');
    for (const key of ['list', 'personal', 'household', 'calendar']) {
      if (groupValues.has(storedGroups[key])) state.groupModes[key] = storedGroups[key];
    }

    const storedSort = JSON.parse(localStorage.getItem(TASK_SORT_STATE_KEY) || '{}');
    if (sortValues.has(storedSort.sheet?.field) && ['asc', 'desc'].includes(storedSort.sheet?.direction)) {
      state.sheetSort = storedSort.sheet;
    }
    state.bucketSorts = new Map((Array.isArray(storedSort.buckets) ? storedSort.buckets : []).filter(([key, value]) =>
      typeof key === 'string' && sortValues.has(value?.field) && ['asc', 'desc'].includes(value?.direction)
    ));

    const progressMode = localStorage.getItem(TASK_PROGRESS_MODE_KEY);
    if (PROGRESS_MODES().some((mode) => mode.value === progressMode)) state.progressMode = progressMode;
  } catch {
    state.bucketSorts = new Map();
  }
  syncActiveGroupMode();
}

/**
 * Aufgaben nach der Toolbar-Suche gefiltert. Rein clientseitig über Titel und
 * Beschreibung — die Serverfilter (Status/Priorität/Person) laufen weiter über
 * loadTasks(). state.tasks bleibt ungefiltert, damit Zähler wie das
 * Überfällig-Badge die Gesamtlage melden und nicht die Suchtreffer.
 */
function filteredTasks() {
  const q = state.searchQuery.trim().toLowerCase();
  if (!q) return state.tasks;
  return state.tasks.filter((task) =>
    (task.title       || '').toLowerCase().includes(q) ||
    (task.description || '').toLowerCase().includes(q) ||
    (task.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
  );
}

// --------------------------------------------------------
// API-Aktionen
// --------------------------------------------------------

/**
 * Query-String für /tasks aus dem aktuellen Filterzustand.
 *
 * Geteilt zwischen dem ersten Aufbau der Seite und jedem Nachladen: die Liste
 * stand zweimal da und ist beim Hinzukommen des Tag-Filters prompt
 * auseinandergelaufen.
 */
function taskQuery() {
  const params = new URLSearchParams();
  // Kanban-Spalten SIND der Status: den Statusfilter dort nicht an den Server
  // senden, sonst blieben "In Bearbeitung"/"Erledigt" trotz vorhandener Aufgaben
  // leer (Audit A1-07/P3). In der Liste wirkt er normal; state bleibt erhalten,
  // sodass der Filter beim Zurückwechseln wieder greift.
  // append statt set: jeder Wert ist ein eigener Parameter. Bei den Tags, damit
  // ein Tag mit Komma im Namen am Server nicht in zwei zerfällt; bei den übrigen
  // Achsen, weil sie seit #671 mehrere Werte tragen (ODER-verknüpft).
  if (state.viewMode !== 'kanban') state.filters.status.forEach((v) => params.append('status', v));
  // Im Kanban ist die Ablage eine Spalte — sie muss also mitkommen, obwohl der
  // Server sie sonst ausblendet (#688).
  else params.set('archived', '1');
  state.filters.priority.forEach((v) => params.append('priority', v));
  state.filters.assigned_to.forEach((v) => params.append('assigned_to', v));
  state.filters.tags.forEach((tag) => params.append('tag', tag));
  if (state.showFuture || state.viewMode === 'calendar') params.set('include_future', '1');
  return params.toString() ? `?${params}` : '';
}

async function loadTasks(container) {
  // Ohne Container steht diese Seite gar nicht - die Aufgabe wurde von der
  // Uebersicht oder aus dem Kalender geoeffnet (#918), und dort frischt der
  // Aufrufer seine eigene Ansicht auf.
  if (!container) return;
  persistAssignedToMe();
  const data  = await api.get(`/tasks${taskQuery()}`);
  state.tasks = data.data ?? [];
  renderTaskList(container);
}

/**
 * Vergebene Tags nachladen (#586). Nur nach dem Speichern nötig, nicht bei jedem
 * Filterwechsel - die Liste ändert sich ausschließlich durch Bearbeiten.
 * Scheitert der Aufruf, bleibt die alte Liste stehen: veraltete Vorschläge sind
 * harmloser als eine plötzlich verschwundene Filtergruppe.
 */
async function refreshTags() {
  try {
    const res = await api.get('/tasks/tags');
    state.allTags = res.data ?? [];
  } catch { /* alte Liste behalten */ }
}

async function toggleTaskStatus(id, currentStatus) {
  const next = currentStatus === 'done' ? 'open' : 'done';
  await api.patch(`/tasks/${id}/status`, { status: next });
}

async function loadTaskForEdit(id) {
  const data = await api.get(`/tasks/${id}`);
  return data.data;
}

async function loadReminderForTask(taskId) {
  try {
    const data = await api.get(`/reminders?entity_type=task&entity_id=${taskId}`);
    return data.data;
  } catch {
    return null;
  }
}

function renderReminderSection(task = null, reminder = null) {
  const hasReminder = !!reminder;
  const resolved = resolveReminderPreset(task, reminder);
  const showCustom = hasReminder && resolved.preset === 'offset_custom';

  return `
    <div class="reminder-section">
      <div class="reminder-section__header">
        <label class="toggle" style="margin:0">
          <input type="checkbox" id="reminder-toggle" ${hasReminder ? 'checked' : ''}>
          <span class="toggle__track"></span>
          <span class="reminder-section__title">${t('reminders.enableLabel')}</span>
        </label>
      </div>
      <div id="reminder-fields" class="reminder-fields" ${hasReminder ? '' : 'style="display:none"'}>
        <div class="form-group" style="margin:0">
          <label class="label" for="reminder-offset">${t('reminders.offsetLabel')}</label>
          <select class="input" id="reminder-offset">
            <option value="offset_none">${t('reminders.offsetNone')}</option>
            <option value="offset_at_time" ${resolved.preset === 'offset_at_time' ? 'selected' : ''}>${t('reminders.offsetAtTime')}</option>
            <option value="offset_15m" ${resolved.preset === 'offset_15m' ? 'selected' : ''}>${t('reminders.offset15min')}</option>
            <option value="offset_1h" ${resolved.preset === 'offset_1h' ? 'selected' : ''}>${t('reminders.offset1hour')}</option>
            <option value="offset_1d" ${resolved.preset === 'offset_1d' ? 'selected' : ''}>${t('reminders.offset1day')}</option>
            <option value="offset_2d" ${resolved.preset === 'offset_2d' ? 'selected' : ''}>${t('reminders.offset2days')}</option>
            <option value="offset_1w" ${resolved.preset === 'offset_1w' ? 'selected' : ''}>${t('reminders.offset1week')}</option>
            <option value="offset_2w" ${resolved.preset === 'offset_2w' ? 'selected' : ''}>${t('reminders.offset2weeks')}</option>
            <option value="offset_custom" ${resolved.preset === 'offset_custom' ? 'selected' : ''}>${t('reminders.offsetCustom')}</option>
          </select>
        </div>
        <div class="modal-grid modal-grid--2" id="reminder-custom-fields" style="${showCustom ? '' : 'display:none'};margin-top:var(--space-3)">
          <div class="form-group" style="margin:0">
            <label class="label" for="reminder-custom-amount">${t('reminders.customAmountLabel')}</label>
            <input class="input" type="number" min="1" step="1" id="reminder-custom-amount" value="${resolved.amount}">
          </div>
          <div class="form-group" style="margin:0">
            <label class="label" for="reminder-custom-unit">${t('reminders.customUnitLabel')}</label>
            <select class="input" id="reminder-custom-unit">
              <option value="minutes" ${resolved.unit === 'minutes' ? 'selected' : ''}>${t('reminders.customMinutes')}</option>
              <option value="hours" ${resolved.unit === 'hours' ? 'selected' : ''}>${t('reminders.customHours')}</option>
              <option value="days" ${resolved.unit === 'days' ? 'selected' : ''}>${t('reminders.customDays')}</option>
              <option value="weeks" ${resolved.unit === 'weeks' ? 'selected' : ''}>${t('reminders.customWeeks')}</option>
            </select>
          </div>
        </div>
      </div>
    </div>`;
}

// --------------------------------------------------------
// Modal-Verwaltung (delegiert an Shared Modal-System)
// --------------------------------------------------------

// Blendet einen Hinweis ein, wenn „Nur Zugewiesene" gewählt ist, aber niemand
// zugewiesen wurde — dann sieht faktisch nur der Ersteller den Eintrag (#474 Guard).
function wireVisibilityWarning(panel, selectSel, msName, warnSel) {
  const select = panel.querySelector(selectSel);
  const warn   = panel.querySelector(warnSel);
  if (!select || !warn) return;
  const ms = panel.querySelector(`.user-ms[data-ms-name="${msName}"]`);
  const rotation = panel.querySelector('#task-round-robin-assignment');
  const mode = panel.querySelector('#task-assignment-mode');
  const activity = panel.querySelector('#task-activity-template');
  const update = () => {
    const count = activity?.value
      ? 1
      : (mode?.value === 'round_robin'
        ? getRotationUserIds(panel).length
        : getSelectedUserIds(panel, msName).length);
    warn.hidden = !(select.value === 'assignees' && count === 0);
  };
  select.addEventListener('change', update);
  mode?.addEventListener('change', update);
  activity?.addEventListener('change', update);
  ms?.addEventListener('click', () => setTimeout(update, 0));
  rotation?.addEventListener('input', update);
  update();
}

function wireAssignmentMode(panel) {
  const activity = panel.querySelector('#task-activity-template');
  const subject = panel.querySelector('#task-activity-subject');
  const modeWrap = panel.querySelector('#task-manual-assignment-mode');
  const mode = panel.querySelector('#task-assignment-mode');
  const fixed = panel.querySelector('#task-fixed-assignment');
  const rotation = panel.querySelector('#task-round-robin-assignment');
  if (!mode || !fixed || !rotation) return;
  const update = () => {
    const managed = !!activity?.value;
    const requiresSubject = managed
      && activity.selectedOptions?.[0]?.dataset.subjectRequired === '1';
    const manualVisible = !managed && !isSoloHousehold();
    if (subject) subject.hidden = !requiresSubject;
    if (modeWrap) modeWrap.hidden = !manualVisible;
    const roundRobin = manualVisible && mode.value === 'round_robin';
    fixed.hidden = !manualVisible || roundRobin;
    rotation.hidden = !roundRobin;
  };
  activity?.addEventListener('change', update);
  mode.addEventListener('change', update);
  update();
}

function renderActivityTemplateText(value, subjectName = '') {
  return String(value || '').replaceAll('{subject}', subjectName || 'the selected member').trim();
}

/**
 * Activity Templates used to be a buried assignment toggle: selecting one did
 * not even fill the title or instructions that make it a template. Keep the
 * ordinary Task editor, but let the template provide a useful starting point.
 */
function wireActivityTemplatePrefill(panel, { task = null, presetActivityTemplate = null } = {}) {
  const select = panel.querySelector('#task-activity-template');
  const subject = panel.querySelector('#task-activity-subject-user');
  const title = panel.querySelector('#task-title');
  const description = panel.querySelector('#task-description');
  const category = panel.querySelector('#task-category');
  if (!select || !title) return;

  const selectedTemplate = () => state.activityTemplates.find(
    (entry) => Number(entry.id) === Number(select.value),
  ) ?? (Number(presetActivityTemplate?.id) === Number(select.value) ? presetActivityTemplate : null);
  const subjectName = () => subject?.selectedOptions?.[0]?.value
    ? subject.selectedOptions[0].textContent.trim()
    : '';

  const applyTemplate = () => {
    const template = selectedTemplate();
    if (!template) return;
    title.value = renderActivityTemplateText(template.title_template || template.name, subjectName());
    title.dataset.activityTemplateAutofill = String(template.id);
    if (description) description.value = renderActivityTemplateText(template.description, subjectName());
    if (category && [...category.options].some((option) => option.value === template.category)) {
      category.value = template.category;
    }
  };

  select.addEventListener('change', applyTemplate);
  subject?.addEventListener('change', () => {
    const template = selectedTemplate();
    if (template && title.dataset.activityTemplateAutofill === String(template.id)) {
      title.value = renderActivityTemplateText(template.title_template || template.name, subjectName());
    }
  });
  title.addEventListener('input', () => delete title.dataset.activityTemplateAutofill);

  if (!task && presetActivityTemplate) applyTemplate();
}

/**
 * Der Countdown-Schalter haengt an der Faelligkeit (#647).
 *
 * GESPERRT UND NICHT NUR BESCHRIFTET. Die Hilfszeile sagte „Braucht ein
 * Faelligkeitsdatum" und der Schalter liess sich trotzdem setzen: gespeichert
 * wurde `countdown: 1` bei `due_date: null`, der Toast meldete Erfolg, und der
 * Eintrag erschien nie auf der Uebersicht. Ein Hinweis erklaert einen Fehler,
 * er verhindert ihn nicht.
 *
 * Der Haken wird beim Sperren MITGENOMMEN, nicht stehengelassen: ein
 * abgehakter, grauer Schalter behauptet einen Zustand, den der Server nicht
 * kennt. Wer die Faelligkeit wieder setzt, findet ihn aus - das ist ehrlicher
 * als ein Haken, der zurueckkommt, ohne dass jemand ihn gesetzt hat.
 *
 * `yuvomi-datepicker` meldet seine Aenderung als `change` am eigenen Element;
 * `input` kommt aus dem inneren Feld beim Tippen. Beide anhoeren, sonst haengt
 * der Schalter je nach Bedienweg (Kalenderblatt vs. Tastatur) hinterher.
 */
function wireCountdownGate(panel) {
  const toggle = panel.querySelector('#task-countdown');
  const due    = panel.querySelector('#task-due-date');
  const warn   = panel.querySelector('#task-countdown-warning');
  if (!toggle || !due) return;
  const update = () => {
    const hasDue = !!parseDateInput(due.value || '');
    if (!hasDue && toggle.checked) toggle.checked = false;
    toggle.disabled = !hasDue;
    if (warn) warn.hidden = hasDue;
  };
  due.addEventListener('change', update);
  due.addEventListener('input', update);
  update();
}

function openTaskModal({ task = null, users = [], reminder = null, presetActivityTemplate = null, presetDates = null } = {}, container) {
  const isEdit = !!task;
  // Working-Set VOR dem Rendern setzen: renderTagChips liest ihn direkt danach.
  modalTags = normalizeTagList(task?.tags);
  openSharedModal({
    title: isEdit ? t('tasks.editTask') : t('tasks.newTask'),
    content: renderModalContent({ task, users, reminder, presetActivityTemplate, presetDates }),
    size: 'lg',
    // Eine neue Aufgabe startet weiterhin mit dem Fokus im Titelfeld - hier ist
    // Tippen die Absicht.
    onSave(panel) { wireTaskForm(panel, { task, container, presetActivityTemplate }); },
  });
}

/**
 * Verdrahtet das Aufgaben-Formular. Eigene Funktion, weil das Formular an zwei
 * Orten entsteht: als eigenes Modal (neue Aufgabe) und als zweites Pane der
 * Detailansicht, das erst beim Wechsel gemountet wird.
 */
/**
 * Die Dokument-Sichtbarkeit, die zur Sichtbarkeit der Aufgabe passt.
 *
 * Die beiden Vokabulare sind nicht dasselbe: eine Aufgabe kennt
 * `all|assignees|private`, ein Dokument `family|restricted|private`. Uebersetzt
 * wird auf die jeweils engere Entsprechung - eine offene Aufgabe teilt ihren
 * Anhang mit dem Haushalt, eine private behaelt ihn, und „nur Beteiligte" wird
 * zur ausdruecklichen Freigabeliste.
 */
function taskDocumentVisibility(panel) {
  const value = panel.querySelector('#task-visibility')?.value || 'all';
  if (value === 'private') return 'private';
  if (value === 'assignees') return 'restricted';
  return 'family';
}

/**
 * @param {HTMLElement} panel
 * @param {{task?: object|null, container?: HTMLElement|null,
 *          presetActivityTemplate?: object|null,
 *          onChanged?: () => (void|Promise<void>)}} opts
 *        `onChanged` frischt auf, was nach dem Speichern anders aussieht.
 *        Voreingestellt ist die Liste dieser Seite; wer das Formular von
 *        aussen mountet (#918, openTaskById), setzt seine eigene Ansicht ein -
 *        die Uebersicht haelt keine Aufgabenliste, die sich neu zeichnen liesse.
 */
function wireTaskForm(panel, {
  task = null,
  container = null,
  presetActivityTemplate = null,
  onChanged = () => loadTasks(container),
}) {
  panel.querySelector('.modal-panel__body')?.classList.add('modal-panel__body--tasks-fit');
  // RRULE-Events binden
  bindRRuleEvents(document, 'task');
  bindUserMultiSelect(panel, 'task_assigned');
  wireAssignmentMode(panel);
  wireActivityTemplatePrefill(panel, { task, presetActivityTemplate });
  wireVisibilityWarning(panel, '#task-visibility', 'task_assigned', '#task-visibility-warning');
  wireCountdownGate(panel);
  wireTaskLocationForm(panel);
  panel.querySelector('[data-activity-reassign-submit]')?.addEventListener('click', async (event) => {
    const userId = Number(panel.querySelector('[data-activity-reassign]')?.value);
    event.currentTarget.disabled = true;
    try {
      await api.put(`/automation/tasks/${event.currentTarget.dataset.taskId}/assignment`, { user_id: userId });
      window.yuvomi.showToast('Assignment updated.', 'success');
      closeSharedModal({ force: true });
      await onChanged();
    } catch (err) {
      window.yuvomi.showToast(err.data?.error || err.message, 'danger');
      event.currentTarget.disabled = false;
    }
  });

  // Tag-Editor (#586)
  renderTagChips(panel);
  wireTagEditor(panel);

  // Formatierungsleiste ueber der Notiz (#731). Die Leseansicht rendert sie
  // seit v2.7.0 als Markdown, geschrieben werden musste sie aber von Hand -
  // dieselbe Leiste, die die Notizen seit jeher haben, dieselbe Datei.
  const description = panel.querySelector('#task-description');
  if (description) wireMarkdownToolbar(panel, description);

  // Verknüpfte Dokumente: hochladen oder ein abgelegtes wählen (#503, #733).
  // Die Vorbelegung steckt bereits im Markup (task.documents aus GET /tasks/:id),
  // hier wird nur noch verdrahtet.
  taskDocuments = bindDocumentAttachField(panel, {
    category: 'other',
    folderKey: 'tasks',
    folderName: t('documents.tasksFolder'),
    // Die Datei erbt die Sichtbarkeit ihrer Aufgabe. Ohne das laege der Beleg
    // einer PRIVATEN Aufgabe als familiensichtbares Dokument im Dokumente-Modul:
    // die Aufgabe waere verborgen, der Zettel darin fuer alle lesbar. Bei
    // „nur Beteiligte" traegt das Dokument dieselbe Liste - `restricted` mit den
    // zugewiesenen Personen. Ausgewertet wird erst beim Hochladen, weil das
    // Sichtbarkeitsfeld bis dahin noch umgestellt werden kann.
    //
    // Eine MOMENTAUFNAHME, kein Dauerabgleich: wechselt die Aufgabe spaeter ihre
    // Sichtbarkeit oder ihre Zuweisungen, bleibt die Freigabe des Dokuments
    // stehen. Sie nachzuziehen hiesse, in Dokumente hineinzuschreiben, wo die
    // Datei danach lebt und wo sie jemand bewusst anders freigegeben haben kann
    // - eine Aufgabenzuweisung darf keine fremde Freigabe ueberschreiben.
    visibility: () => taskDocumentVisibility(panel),
    // Wer die Aufgabe sieht, sieht ihren Anhang: bei „nur Beteiligte" sind das
    // die Zugewiesenen UND die Person, die die Aufgabe angelegt hat. Ohne sie
    // laedt eine zugewiesene Person eine Datei hoch, und der Ersteller - der die
    // Aufgabe oeffnen darf - findet dort eine Zeile weniger als vorhanden ist.
    allowedMemberIds: () => {
      let ids;
      if (panel.querySelector('#task-activity-template')?.value) {
        const persistedAssignee = Number(task?.assigned_to);
        ids = Number.isInteger(persistedAssignee) && persistedAssignee > 0 ? [persistedAssignee] : [];
      } else if (panel.querySelector('#task-assignment-mode')?.value === 'round_robin') {
        const rotationIds = getRotationUserIds(panel).map(Number);
        const persistedAssignee = Number(task?.assigned_to);
        if (Number.isInteger(persistedAssignee) && persistedAssignee > 0) {
          ids = [persistedAssignee];
        } else {
          const grouped = !!panel.querySelector('#task-rotation-group')?.value.trim();
          const position = Number(panel.querySelector('#task-rotation-position')?.value || 1);
          const slot = grouped && Number.isInteger(position) && position > 0 ? position - 1 : 0;
          const active = rotationIds[slot];
          ids = Number.isInteger(active) && active > 0 ? [active] : [];
        }
      } else {
        ids = getSelectedUserIds(panel, 'task_assigned').map(Number);
      }
      const creator = Number(task?.created_by ?? state.currentUserId);
      if (Number.isInteger(creator) && !ids.includes(creator)) ids.push(creator);
      return ids;
    },
  });

  // Sync-Ziel nachladen (#695). Ohne await: die Liste kommt aus dem Netz, und
  // bis sie da ist, steht "nur lokal" - das ist der richtige Zwischenzustand.
  wireSyncTarget(panel, task);

  // Blur-Validierung für required-Felder aktivieren
  wireBlurValidation(panel);

  // Reminder-Toggle: Felder ein-/ausblenden
  const toggle = panel.querySelector('#reminder-toggle');
  const fields = panel.querySelector('#reminder-fields');
  const offset = panel.querySelector('#reminder-offset');
  const customFields = panel.querySelector('#reminder-custom-fields');
  toggle?.addEventListener('change', () => {
    fields.style.display = toggle.checked ? '' : 'none';
  });
  offset?.addEventListener('change', () => {
    if (!customFields) return;
    customFields.style.display = offset.value === 'offset_custom' ? '' : 'none';
  });
  // Form-Events
  panel.querySelector('#task-form')
    ?.addEventListener('submit', (e) => handleFormSubmit(e, { container, onChanged }));

  panel.querySelector('[data-action="delete-task"]')
    ?.addEventListener('click', (e) => deleteTaskWithUndo(e.currentTarget.dataset.id, {
      container, onChanged,
    }));
}

// --------------------------------------------------------
// Tag-Verwaltung und Bulk-Vergabe (#586)
// --------------------------------------------------------

/**
 * Tags haushaltsweit umbenennen, zusammenführen und entfernen.
 * Nach jeder Änderung wandert die frische Liste direkt in den State - der
 * Server liefert sie in derselben Antwort mit, ein Nachladen entfällt.
 */
function openTagManager(container) {
  let manager = null;
  const onChanged = async (e) => {
    state.allTags = e.detail?.tags ?? state.allTags;
    // Ein Tag, der gerade umbenannt oder gelöscht wurde, kann noch im Filter
    // stehen. Bliebe er dort, filterte die Liste auf einen Namen, den es nicht
    // mehr gibt, und zeigte dauerhaft nichts an.
    const known = new Set(state.allTags.map((entry) => entry.tag.toLowerCase()));
    state.filters.tags = state.filters.tags.filter((tag) => known.has(tag.toLowerCase()));
    renderFilters(container);
    await loadTasks(container);
  };
  openSharedModal({
    title: t('tasks.manageTags'),
    content: '<yuvomi-tag-manager></yuvomi-tag-manager>',
    size: 'lg',
    onSave: (panel) => {
      manager = panel.querySelector('yuvomi-tag-manager');
      manager.addEventListener('tag-manager-changed', onChanged);
    },
    onClose: () => manager?.removeEventListener('tag-manager-changed', onChanged),
  });
}

/**
 * Tag an die ausgewählten Aufgaben hängen oder von ihnen nehmen.
 *
 * Beim Entfernen kommen die Vorschläge aus den ausgewählten Aufgaben selbst,
 * nicht aus dem Gesamtbestand: einen Tag anzubieten, den keine der markierten
 * Aufgaben trägt, wäre eine Aktion, die garantiert nichts tut.
 */
function openBulkTagDialog(taskIds, mode, container) {
  const selected = state.tasks.filter((task) => taskIds.includes(task.id));
  const pool = mode === 'remove'
    ? [...new Map(selected.flatMap((task) => task.tags ?? [])
        .map((tag) => [tag.toLowerCase(), tag])).values()].sort((a, b) =>
          a.localeCompare(b, getLocale(), { sensitivity: 'base' }))
    : state.allTags.map((entry) => entry.tag);

  openSharedModal({
    title: mode === 'add' ? t('tasks.bulkTagAdd') : t('tasks.bulkTagRemove'),
    size: 'sm',
    content: `
      <form id="bulk-tag-form">
        <div class="form-group">
          <label class="label" for="bulk-tag-input">${t('tasks.tagsLabel')}</label>
          <input class="input" type="text" id="bulk-tag-input" name="tag" autocomplete="off"
                 list="bulk-tag-suggestions" maxlength="64"
                 placeholder="${t('tasks.tagsPlaceholder')}">
          <datalist id="bulk-tag-suggestions">
            ${pool.map((tag) => `<option value="${esc(tag)}"></option>`).join('')}
          </datalist>
          <p class="task-field-hint">${t('tasks.bulkTagHint', { count: taskIds.length })}</p>
        </div>
        <div class="modal-actions">
          <button type="submit" class="btn btn--primary">${t('common.apply')}</button>
        </div>
      </form>`,
    onSave: (panel) => {
      const form = panel.querySelector('#bulk-tag-form');
      panel.querySelector('#bulk-tag-input')?.focus();
      form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const tag = form.elements.tag.value.trim();
        if (!tag) return;
        try {
          const body = mode === 'add' ? { ids: taskIds, add: [tag] } : { ids: taskIds, remove: [tag] };
          const res = await api.post('/tasks/tags/apply', body);
          state.allTags = res.data?.tags ?? state.allTags;
          // Der Server ueberspringt gesperrte Aufgaben, statt den ganzen Aufruf
          // abzuweisen (#830). Eine stille Teilausfuehrung waere schlimmer als
          // ein Fehler, also sagt der Toast, was liegen blieb.
          const skipped = res.data?.skipped ?? 0;
          window.yuvomi.showToast(
            skipped
              ? `${t('tasks.tagsUpdated', { count: res.data?.updated ?? 0 })} ${t('tasks.tagsSkippedLocked', { count: skipped })}`
              : t('tasks.tagsUpdated', { count: res.data?.updated ?? 0 }),
            'success');
          closeModal({ force: true });
          state.selectedTaskIds.clear();
          updateBulkActionsBar(container);
          renderFilters(container);
          await loadTasks(container);
        } catch (err) {
          window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
        }
      });
    },
  });
}

// --------------------------------------------------------
// Kategorie-Verwaltung (#494)
// --------------------------------------------------------

function openTaskCategoryManager(container) {
  let manager = null;
  const onChanged = async () => {
    try {
      const res = await api.get('/tasks/categories');
      state.categories = res.data ?? [];
      renderTaskList(container);
    } catch { /* Fehler wurde bereits vom Manager als Toast angezeigt */ }
  };
  openSharedModal({
    title: t('tasks.manageCategories'),
    content: '<yuvomi-category-manager></yuvomi-category-manager>',
    size: 'lg',
    onSave: (panel) => {
      manager = panel.querySelector('yuvomi-category-manager');
      manager.addEventListener('category-manager-changed', onChanged);
      manager.configure({
        basePath: '/tasks/categories',
        groups: [{ key: '', addLabelKey: 'tasks.addCategory' }],
        labelResolver: (item) => (item.label_key ? t(item.label_key) : (item.name || item.key)),
        titleKey: 'tasks.manageCategories',
        hintKey: 'category.manageHint',
        deleteDetailKey: 'category.deleteConfirmDetail',
      });
    },
    onClose: () => manager?.removeEventListener('category-manager-changed', onChanged),
  });
}

// --------------------------------------------------------
// Formular-Handler
// --------------------------------------------------------

async function handleFormSubmit(e, { container = null, onChanged = () => loadTasks(container) } = {}) {
  e.preventDefault();
  const form      = e.target;
  const errorEl   = document.getElementById('task-form-error');
  const submitBtn = document.getElementById('task-submit-btn');
  const taskId    = document.getElementById('task-id').value;

  // Alle required-Felder sofort validieren (auch unberührte)
  if (!validateAll(form)) return;

  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = t('common.saving');

  const originalLabel = taskId ? t('common.save') : t('common.create');

  const startDateRaw = form.start_date?.value || '';
  const startDate = parseDateInput(startDateRaw);
  const dueDateRaw = form.due_date?.value || '';
  const dueDate = parseDateInput(dueDateRaw);
  const rrule = getRRuleValues(document, 'task');
  const reminderToggle = form.querySelector('#reminder-toggle');
  if ((startDateRaw && !isDateInputValid(startDateRaw)) || !isDateInputValid(dueDateRaw) || !rrule.valid_until) {
    errorEl.textContent = t('calendar.invalidDate');
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    return;
  }
  // Ein noch nicht übernommener Tag im Eingabefeld zählt mit — wer tippt und
  // direkt speichert, hat ihn gemeint.
  const pendingTag = form.querySelector('#task-tag-input')?.value ?? '';
  const tags = normalizeTagList([...modalTags, ...pendingTag.split(',')]);
  const activitySelect = form.querySelector('#task-activity-template');
  const activityTemplateId = activitySelect?.value ? Number(activitySelect.value) : null;
  const activityRequiresSubject = !!activityTemplateId
    && activitySelect?.selectedOptions?.[0]?.dataset.subjectRequired === '1';
  const activitySubjectUserId = activityRequiresSubject
    ? Number(form.querySelector('#task-activity-subject-user')?.value || 0) || null
    : null;
  const managedActivity = Number.isInteger(activityTemplateId) && activityTemplateId > 0;
  const assignmentMode = managedActivity ? 'fixed' : (form.querySelector('#task-assignment-mode')?.value || 'fixed');
  const rotationUserIds = managedActivity ? [] : getRotationUserIds(form);
  const rotationGroup = managedActivity ? '' : (form.querySelector('#task-rotation-group')?.value.trim() || '');
  const rotationPosition = Number(form.querySelector('#task-rotation-position')?.value || 1);

  const body = {
    title:           form.title.value.trim(),
    description:     form.description.value.trim() || null,
    priority:        form.priority.value,
    category:        form.category.value,
    tags,
    start_date:      startDate || null,
    due_date:        dueDate || null,
    assigned_to:     !managedActivity && assignmentMode === 'fixed' ? getSelectedUserIds(form, 'task_assigned') : [],
    activity_template_id: managedActivity ? activityTemplateId : null,
    activity_subject_user_id: managedActivity ? activitySubjectUserId : null,
    assignment_mode: assignmentMode,
    rotation_user_ids: !managedActivity && assignmentMode === 'round_robin' ? rotationUserIds : [],
    rotation_group: assignmentMode === 'round_robin' && rotationGroup ? rotationGroup : null,
    rotation_slot: assignmentMode === 'round_robin' && rotationGroup ? rotationPosition - 1 : 0,
    visibility:      form.querySelector('#task-visibility')?.value || 'all',
    is_recurring:    rrule.is_recurring ? 1 : 0,
    recurrence_rule: rrule.recurrence_rule,
    recurrence_from_completion: rrule.recurrence_from_completion ? 1 : 0,
    countdown:       form.querySelector('#task-countdown')?.checked ? 1 : 0,
    locked:          form.querySelector('#task-locked')?.checked ? 1 : 0,
    points:          Math.max(0, Math.trunc(Number(form.points?.value)) || 0),
    location:        readTaskLocation(form),
  };
  // Das Feld fehlt bei Unteraufgaben und bei bereits gespiegelten Aufgaben - in
  // beiden Fällen soll gar kein Ziel mitgeschickt werden, sonst nähme der Server
  // das Fehlen als "auf lokal zurücksetzen" (#695).
  const syncTargetField = form.querySelector('#task-sync-target');
  if (syncTargetField) body.sync_target = syncTargetField.value;
  const dueTimeRaw = form.due_time?.value || '';
  const dueTime = parseTimeInput(dueTimeRaw);
  const resetSubmit = (msg) => {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  };
  if (dueTimeRaw && !dueTime) { resetSubmit(t('calendar.invalidDate')); return; }
  body.due_time = dueTime || null;
  if (form.status) body.status = form.status.value;
  if (managedActivity && activityRequiresSubject && !activitySubjectUserId) {
    resetSubmit('Choose a household member for this Activity Template.'); return;
  }
  if (!managedActivity && assignmentMode === 'round_robin') {
    if (!rrule.is_recurring) { resetSubmit('Round robin requires a recurring task.'); return; }
    if (rotationUserIds.length < 2) { resetSubmit('Choose at least two members for the round-robin rotation.'); return; }
    if (rotationGroup && (!Number.isInteger(rotationPosition) || rotationPosition < 1 || rotationPosition > rotationUserIds.length)) {
      resetSubmit('Rotation group position must be between 1 and the number of rotation members.'); return;
    }
  }

  // Erinnerungs-Vorbedingungen VOR dem Speichern prüfen — verhindert den
  // widersprüchlichen Zustand "Aufgabe gespeichert (Erfolgs-Toast) + roter
  // Fehler", wenn Reminder ohne Fälligkeit/Offset gesetzt wird (Critique P2).
  const wantsReminder = !!reminderToggle?.checked;
  let remindAt = null;
  if (wantsReminder) {
    if (!dueDate) { resetSubmit(t('tasks.reminderNeedsDueDate')); return; }
    const offsetPreset = form.querySelector('#reminder-offset')?.value || 'offset_none';
    if (offsetPreset === 'offset_none') { resetSubmit(t('tasks.reminderNeedsDueDate')); return; }
    let offsetMs = 0;
    if (offsetPreset === 'offset_15m') offsetMs = 15 * 60 * 1000;
    else if (offsetPreset === 'offset_1h') offsetMs = 60 * 60 * 1000;
    else if (offsetPreset === 'offset_1d') offsetMs = 24 * 60 * 60 * 1000;
    else if (offsetPreset === 'offset_2d') offsetMs = 2 * 24 * 60 * 60 * 1000;
    else if (offsetPreset === 'offset_1w') offsetMs = 7 * 24 * 60 * 60 * 1000;
    else if (offsetPreset === 'offset_2w') offsetMs = 14 * 24 * 60 * 60 * 1000;
    else if (offsetPreset === 'offset_custom') {
      const customAmount = Number(form.querySelector('#reminder-custom-amount')?.value || 0);
      const customUnit = form.querySelector('#reminder-custom-unit')?.value || 'days';
      if (!Number.isFinite(customAmount) || customAmount <= 0) { resetSubmit(t('common.invalidInput')); return; }
      const unitFactor = customUnit === 'minutes' ? 60000 : customUnit === 'hours' ? 3600000 : customUnit === 'days' ? 86400000 : 604800000;
      offsetMs = customAmount * unitFactor;
    }
    const dueDateTime = body.due_time ? new Date(`${dueDate}T${body.due_time}`) : new Date(`${dueDate}T23:59:59`);
    remindAt = new Date(dueDateTime.getTime() - offsetMs).toISOString().slice(0, 19);
  }

  // Wartende Uploads VOR dem Speichern der Aufgabe (#733): scheitert der
  // Upload, soll die Aufgabe nicht mit dem Gefühl gespeichert sein, der Beleg
  // hänge dran. Dasselbe Vorgehen wie bei den Belegen im Budget.
  // null heißt „kein Feld im Formular" und ist NICHT dasselbe wie „keine
  // Dokumente": ein PUT mit leerer Liste löscht als Replace-Set alles, was an
  // der Aufgabe hängt.
  let documentIds = null;
  try {
    documentIds = taskDocuments ? await taskDocuments.commit() : null;
  } catch (err) {
    resetSubmit(err.message || t('common.errorGeneric'));
    btnError(submitBtn);
    return;
  }

  try {
    let savedTaskId = taskId;
    if (taskId) {
      await api.put(`/tasks/${taskId}`, body);
      window.yuvomi.showToast(t('tasks.savedToast'), 'success');
    } else {
      const res = await api.post('/tasks', body);
      savedTaskId = res.data?.id;
      window.yuvomi.showToast(t('tasks.createdToast'), 'success');
    }

    // Erinnerung speichern oder löschen (Vorbedingungen bereits oben geprüft)
    if (savedTaskId) {
      if (wantsReminder) {
        await api.post('/reminders', { entity_type: 'task', entity_id: savedTaskId, remind_at: remindAt });
        refreshReminders();
      } else {
        try {
          await api.delete(`/reminders?entity_type=task&entity_id=${savedTaskId}`);
          refreshReminders();
        } catch { /* kein Reminder vorhanden - ignorieren */ }
      }

      // Dokument-Verknüpfungen als Replace-Set übernehmen (#503).
      //
      // Der Fehler wird nicht mehr verschluckt: seit hier hochgeladen werden
      // kann (#733), liegt bei einem Fehlschlag eine frische Datei unverknüpft
      // im Dokumente-Modul, während die Aufgabe sich als gespeichert meldet -
      // der Nutzer glaubt, der Zettel hänge dran. Die Aufgabe IST gespeichert,
      // deshalb bleibt das kein Abbruch, sondern eine Meldung, die den einen
      // Teil benennt, der nicht geklappt hat.
      if (documentIds) {
        try {
          await api.put(`/tasks/${savedTaskId}/documents`, { document_ids: documentIds });
        } catch (err) {
          console.error('[Tasks] document link error:', err);
          // Das Formular bleibt STEHEN: die Aufgabe ist gespeichert, aber die
          // Datei haengt nicht an ihr, und ein zuklappendes Modal mit gruenem
          // Haken behauptete das Gegenteil. So bleibt der Weg zum zweiten
          // Versuch offen - die Chips sind noch da, ein erneutes Speichern
          // schickt dieselbe Liste.
          resetSubmit(t('tasks.documentsLinkFailed'));
          btnError(submitBtn);
          await refreshTags();
          await onChanged();
          return;
        }
      }
    }

    btnSuccess(submitBtn, originalLabel);
    setTimeout(() => closeModal({ force: true }), 700);
    // Erst die Tag-Liste, dann neu zeichnen: ein gerade vergebener Tag soll
    // sofort in Filterleiste und Vorschlägen stehen (#586).
    await refreshTags();
    await onChanged();
  } catch (err) {
    resetSubmit(err.message);
    btnError(submitBtn);
  }
}
// --------------------------------------------------------
// Kanban-Ansicht
// --------------------------------------------------------

// Die Spalten sind der Weg einer Aufgabe. Die letzte ist keine Station dieses
// Wegs, sondern die Ablage daneben (#688) - deshalb steht dort 'archived' und
// nicht ein vierter Status.
const KANBAN_COLS = () => [
  { status: 'open',        label: t('tasks.kanbanOpen'),       colorVar: '--color-text-secondary' },
  { status: 'in_progress', label: t('tasks.kanbanInProgress'), colorVar: '--color-warning'        },
  { status: 'done',        label: t('tasks.kanbanDone'),       colorVar: '--color-success'        },
  { status: 'archived',    label: t('tasks.kanbanArchived'),   colorVar: '--color-text-tertiary'  },
];

/** In welcher Spalte steht die Aufgabe? Die Ablage sticht den Status. */
function kanbanColumnOf(task) {
  return isArchived(task) ? 'archived' : task.status;
}

function kanbanNextStatus(status) {
  if (status === 'open')        return 'in_progress';
  if (status === 'in_progress') return 'done';
  return 'open';
}

/**
 * Eine Aufgabe in eine Spalte bewegen - der einzige Weg, auf dem das Board
 * schreibt (Maus-Drop, Touch-Drop und der Weiterschalt-Knopf).
 *
 * Aus der Ablage zurück heißt: zurückholen, Status unangetastet lassen. Genau
 * das ging vorher nicht, weil die Spalte den Status SETZTE - eine erledigte
 * Aufgabe kam als offene zurück (#688).
 */
async function moveTaskToColumn(before, column) {
  // `before` ist der Stand VOR dem optimistischen Update - der State ist zu
  // diesem Zeitpunkt schon umgeschrieben, und die Entscheidung, ob überhaupt ein
  // Statuswechsel nötig ist, muss sich auf den alten Stand beziehen.
  if (column === 'archived') {
    await setTaskArchived(before.id, true);
    return;
  }
  if (before.archived_at) await setTaskArchived(before.id, false);
  if (before.status !== column) await api.patch(`/tasks/${before.id}/status`, { status: column });
}

/** Optimistisches Spiegelbild von moveTaskToColumn auf dem State-Objekt. */
function applyColumnLocally(task, column) {
  if (column === 'archived') {
    task.archived_at = new Date().toISOString();
    return;
  }
  task.archived_at = null;
  task.status = column;
}

/** Board-Bewegung mit optimistischem Vorgriff - der eine Weg für alle drei Gesten. */
async function runColumnMove(task, column, container) {
  const before = { id: task.id, status: task.status, archived_at: task.archived_at };
  applyColumnLocally(task, column);
  renderKanban(container);
  try {
    await moveTaskToColumn(before, column);
  } catch (err) {
    window.yuvomi.showToast(err.message, 'danger');
  }
  await loadTasks(container);
}

function renderKanbanCard(task) {
  const archived = isArchived(task);
  const due  = formatDueDate(task.due_date, task.due_time, task.status === 'done' || archived);
  // Aus der Ablage führt nur ein Schritt: zurück. Wohin, sagt der Status, den
  // die Aufgabe die ganze Zeit behalten hat.
  const next = archived ? task.status : kanbanNextStatus(task.status);
  const icon = archived ? 'archive-restore'
    : next === 'done' ? 'check' : next === 'in_progress' ? 'circle-play' : 'rotate-ccw';
  const nextLabel = archived
    ? t('tasks.unarchiveButton')
    : next === 'done'
      ? t('tasks.kanbanMoveToDone')
      : next === 'in_progress'
        ? t('tasks.kanbanMoveToInProgress')
        : t('tasks.kanbanMoveToOpen');
  return `
    <div class="kanban-card ${task.status === 'done' ? 'kanban-card--done' : ''}"
         data-task-id="${task.id}" draggable="true">
      <!-- Button statt div: einziger Tastaturweg in die Kartendetails; der
           Board-Klick-Handler fängt ihn über den umschließenden [draggable]. -->
      <button type="button" class="kanban-card__title u-card-title u-compact">${esc(task.title)}</button>
      <div class="kanban-card__meta">
        ${renderPriorityBadge(task.priority)}
        ${due ? `<span class="due-date ${due.cls}"><i data-lucide="clock" class="icon-sm" aria-hidden="true"></i> ${due.label}</span>` : ''}
        ${renderTagBadges(task.tags, TAG_BADGES_VISIBLE, task.priority)}
      </div>
      <div class="kanban-card__footer">
        ${renderAvatarStack(task.assigned_users ?? [], { size: 22 }) || '<span></span>'}
        <button class="kanban-card__status-btn" type="button"
                data-next-status="${next}" title="${nextLabel}" aria-label="${nextLabel}">
          <i data-lucide="${icon}" aria-hidden="true"></i>
        </button>
      </div>
    </div>`;
}

function renderLegacyKanban(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  const cols = KANBAN_COLS();
  const grouped = {};
  for (const col of cols) grouped[col.status] = [];
  for (const t of filteredTasks()) {
    const column = kanbanColumnOf(t);
    if (grouped[column]) grouped[column].push(t);
    else grouped['open'].push(t);
  }

  const now = new Date();
  for (const col of cols) {
    grouped[col.status].sort((a, b) => sortTasks(a, b, now));
  }

  // Bei aktiver Suche ohne Treffer wäre ein Board aus lauter „Keine Aufgaben"-
  // Spalten irreführend (wirkt wie ein leeres Modul statt wie ein leeres Such-
  // ergebnis). Stattdessen ein board-weiter Treffer-Empty analog zur Liste,
  // inkl. expliziter Zurücksetzen-Affordanz (Critique P3).
  const isFiltered   = state.searchQuery.trim().length > 0;
  const totalVisible = cols.reduce((n, c) => n + grouped[c.status].length, 0);
  if (isFiltered && totalVisible === 0) {
    listEl.replaceChildren();
    listEl.insertAdjacentHTML('beforeend', emptyStateHTML({
      variant: 'no-results',
      title: t('tasks.noResultsTitle'),
      description: t('tasks.noResultsDescription', { query: state.searchQuery }),
      action: {
        label: t('common.searchClear'),
        icon: 'x',
        attrs: { id: 'kanban-reset-search' },
      },
    }));
    if (window.lucide) window.lucide.createIcons({ el: listEl });
    listEl.querySelector('#kanban-reset-search')?.addEventListener('click', () => {
      state.searchQuery = '';
      const input = container.querySelector('#tasks-search');
      if (input) input.value = '';
      container.querySelector('[data-page-search-clear]')?.setAttribute('hidden', '');
      renderTaskList(container);
    });
    return;
  }

  const kanbanHtml = `
    <div class="kanban-board">
      ${cols.map((col) => `
        <div class="kanban-col" data-status="${col.status}">
          <div class="kanban-col__header">
            <span class="kanban-col__title" style="color:${col.colorVar.startsWith('--') ? `var(${col.colorVar})` : col.colorVar}">
              ${col.label}
            </span>
            <span class="kanban-col__count">${grouped[col.status].length}</span>
          </div>
          <div class="kanban-col__body" data-drop-zone="${col.status}">
            ${grouped[col.status].length
              ? grouped[col.status].map((task) => renderKanbanCard(task)).join('')
              : `<div class="kanban-col__empty">
                   <span class="kanban-col__empty-idle">${t('tasks.kanbanColEmpty')}</span>
                   <span class="kanban-col__empty-drop">${t('tasks.kanbanDropHint')}</span>
                 </div>`}
            <div class="kanban-drop-placeholder" hidden></div>
          </div>
        </div>
      `).join('')}
    </div>`;
  listEl.replaceChildren();
  listEl.insertAdjacentHTML('beforeend', kanbanHtml);

  if (window.lucide) window.lucide.createIcons({ el: listEl });
  wireKanbanDrag(container);
  wireKanbanTouch(container);
}

function isBoardSectionCollapsed(key, status) {
  if (state.expandedBoardSections.has(key)) return false;
  if (state.collapsedBoardSections.has(key)) return true;
  return status !== 'open';
}

function renderBoardStatusSection(bucketKey, status, tasks) {
  const statusLabel = status === 'archived'
    ? t('tasks.statusArchived')
    : (STATUS_LABELS()[status] || status);
  const sectionKey = `${bucketKey}:${status}`;
  const collapsed = isBoardSectionCollapsed(sectionKey, status);
  const sorted = sortedTasks(tasks, bucketKey);
  return `<section class="task-status-bucket${collapsed ? ' task-status-bucket--collapsed' : ''}" data-board-section="${esc(sectionKey)}">
    <h3 class="task-status-bucket__heading">
      <button type="button" class="task-status-bucket__toggle" data-action="toggle-board-section"
        data-section-key="${esc(sectionKey)}" data-section-status="${status}" aria-expanded="${!collapsed}">
        <i data-lucide="chevron-right" class="activity-card__chevron${collapsed ? '' : ' activity-card__chevron--open'}" aria-hidden="true"></i>
        <span>${esc(statusLabel)}</span>
      </button>
      <span class="task-status-bucket__count">${tasks.length}</span>
    </h3>
    ${collapsed ? '' : `<div class="kanban-col__body task-status-bucket__body" data-drop-zone="${status}">
      ${sorted.length ? sorted.map((task) => renderTaskCard(task, {
        board: true,
        expandedSubtasks: isSubtasksExpanded(task.id),
        showCategory: state.groupMode !== 'category',
      })).join('') : `<div class="kanban-col__empty"><span class="kanban-col__empty-idle">${esc(t('tasks.kanbanColEmpty'))}</span><span class="kanban-col__empty-drop">${esc(t('tasks.kanbanDropHint'))}</span></div>`}
      <div class="kanban-drop-placeholder" hidden></div>
    </div>`}
  </section>`;
}

function renderKanban(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;
  state.boardScope = deviceTaskBoardScope();
  syncActiveGroupMode();
  const tasks = boardTasks();
  const buckets = taskBuckets(tasks, state.groupMode, {
    includeEmptyAssignees: state.boardScope === 'household' && state.groupMode === 'assignee',
  });
  const isSearch = state.searchQuery.trim().length > 0;
  if (!buckets.length || (isSearch && !tasks.length)) {
    listEl.replaceChildren();
    listEl.insertAdjacentHTML('beforeend', emptyStateHTML({
      variant: isSearch ? 'no-results' : 'empty',
      icon: isSearch ? undefined : 'circle-check-big',
      title: isSearch ? t('tasks.noResultsTitle') : t('tasks.personalBoardEmpty'),
      description: isSearch
        ? t('tasks.noResultsDescription', { query: state.searchQuery })
        : t('tasks.personalBoardEmptyDescription'),
    }));
    if (window.lucide) window.lucide.createIcons({ el: listEl });
    return;
  }

  const boardClass = state.boardScope === 'household' ? ' task-board--household' : ' task-board--personal';
  listEl.replaceChildren();
  listEl.insertAdjacentHTML('beforeend', `<div class="kanban-board task-board${boardClass}" data-board-scope="${state.boardScope}">
    ${buckets.map((bucket) => {
      const bucketKey = `${state.boardScope}:${state.groupMode}:${bucket.id}`;
      const bucketSort = state.bucketSorts.get(bucketKey);
      const byStatus = new Map([
        ['open', []], ['in_progress', []], ['done', []], ['archived', []],
      ]);
      bucket.tasks.forEach((task) => (byStatus.get(kanbanColumnOf(task)) || byStatus.get('open')).push(task));
      return `<section class="kanban-col task-board__bucket" data-bucket-key="${esc(bucketKey)}">
        <header class="kanban-col__header task-board__bucket-header">
          <div class="task-board__bucket-title">
            ${bucket.user ? renderAvatarStack([normalizeParticipant(bucket.user)], { size: 30, maxVisible: 1 }) : ''}
            <h2 class="kanban-col__title">${esc(bucket.label)}</h2>
            <span class="kanban-col__count">${bucket.tasks.length}</span>
          </div>
          <button type="button" class="btn btn--ghost btn--icon btn--icon-sm task-board__bucket-sort${bucketSort ? ' task-board__bucket-sort--active' : ''}"
            data-action="open-bucket-sort" data-bucket-key="${esc(bucketKey)}"
            aria-label="${esc(t('tasks.bucketSort'))}" aria-expanded="false">
            <i data-lucide="${bucketSort?.locked ? 'lock' : 'arrow-up-down'}" class="icon-sm" aria-hidden="true"></i>
          </button>
        </header>
        <div class="task-board__bucket-scroll">
          ${renderBoardStatusSection(bucketKey, 'open', byStatus.get('open'))}
          ${renderBoardStatusSection(bucketKey, 'in_progress', byStatus.get('in_progress'))}
          ${renderBoardStatusSection(bucketKey, 'done', byStatus.get('done'))}
          ${byStatus.get('archived').length ? renderBoardStatusSection(bucketKey, 'archived', byStatus.get('archived')) : ''}
        </div>
      </section>`;
    }).join('')}
  </div>`);
  if (window.lucide) window.lucide.createIcons({ el: listEl });
  wireKanbanDrag(container);
  wireKanbanTouch(container);
  wireResponsiveTaskTags(listEl);
}

function wireKanbanDrag(container) {
  const board = container.querySelector('.kanban-board');
  if (!board) return;

  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.kanban-card[data-task-id]');
    if (!card) return;
    state.dragTaskId = card.dataset.taskId;
    state.dragBucketKey = card.closest('[data-bucket-key]')?.dataset.bucketKey || null;
    card.classList.add('kanban-card--dragging');
    board.classList.add('kanban-board--dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  board.addEventListener('dragend', (e) => {
    const card = e.target.closest('.kanban-card[data-task-id]');
    if (card) card.classList.remove('kanban-card--dragging');
    board.classList.remove('kanban-board--dragging');
    board.querySelectorAll('.kanban-drop-placeholder').forEach((el) => el.hidden = true);
    board.querySelectorAll('.kanban-col__body--over').forEach((el) =>
      el.classList.remove('kanban-col__body--over')
    );
    state.dragTaskId = null;
    state.dragBucketKey = null;
  });

  board.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const zone = e.target.closest('[data-drop-zone]');
    if (!zone) return;
    board.querySelectorAll('.kanban-col__body--over').forEach((el) =>
      el.classList.remove('kanban-col__body--over')
    );
    zone.classList.add('kanban-col__body--over');
  });

  board.addEventListener('dragleave', (e) => {
    const zone = e.target.closest('[data-drop-zone]');
    if (zone && !zone.contains(e.relatedTarget)) {
      zone.classList.remove('kanban-col__body--over');
    }
  });

  board.addEventListener('drop', async (e) => {
    e.preventDefault();
    const zone = e.target.closest('[data-drop-zone]');
    if (!zone || !state.dragTaskId) return;
    zone.classList.remove('kanban-col__body--over');

    const column = zone.dataset.dropZone;
    const targetBucketKey = zone.closest('[data-bucket-key]')?.dataset.bucketKey || null;
    if (state.dragBucketKey && targetBucketKey && state.dragBucketKey !== targetBucketKey) {
      window.yuvomi.showToast(t('tasks.moveBetweenBucketsHint'), 'default');
      return;
    }
    const task   = state.tasks.find((t) => String(t.id) === String(state.dragTaskId));
    if (!task || kanbanColumnOf(task) === column) return;

    await runColumnMove(task, column, container);
  });

  // Klick auf Status-Button: Status ohne Modal wechseln
  board.addEventListener('click', async (e) => {
    const statusBtn = e.target.closest('[data-next-status]');
    if (statusBtn) {
      e.stopPropagation();
      const card      = statusBtn.closest('.kanban-card[data-task-id]');
      if (!card) return;
      const task = state.tasks.find((t) => String(t.id) === String(card.dataset.taskId));
      if (!task) return;
      // Der Knopf einer abgelegten Karte holt zurück, statt weiterzuschalten -
      // sein data-next-status trägt dann den Status, den die Aufgabe behalten hat.
      await runColumnMove(task, statusBtn.dataset.nextStatus, container);
      return;
    }

    if (e.target.closest('[data-action], [data-tag-filter]')) return;

    // Klick auf Kanban-Card öffnet Edit-Modal
    if (e.target.closest('[draggable]')) {
      const card = e.target.closest('.kanban-card[data-task-id]');
      if (!card) return;
      try {
        const [task, reminder] = await Promise.all([
          loadTaskForEdit(card.dataset.taskId),
          loadReminderForTask(card.dataset.taskId),
        ]);
        openTaskView(task, reminder, container);
      } catch (err) {
        window.yuvomi.showToast(t('tasks.loadError'), 'danger');
      }
    }
  });
}

// --------------------------------------------------------
// Kanban-Touch-Drag (Mobile)
// --------------------------------------------------------

function wireKanbanTouch(container) {
  const board = container.querySelector('.kanban-board');
  if (!board) return;

  let dragging = null;
  let ghost = null;
  let taskId = null;
  let originX = 0, originY = 0;
  let originLeft = 0, originTop = 0;
  let activeZone = null;
  let sourceBucketKey = null;
  let started = false;

  function cleanup() {
    ghost?.remove();
    ghost = null;
    board.classList.remove('kanban-board--dragging');
    if (dragging) {
      dragging.classList.remove('kanban-card--dragging');
      dragging = null;
    }
    board.querySelectorAll('.kanban-col__body--over').forEach((el) =>
      el.classList.remove('kanban-col__body--over')
    );
    activeZone = null;
    started = false;
    taskId = null;
    sourceBucketKey = null;
  }

  board.addEventListener('touchstart', (e) => {
    const card = e.target.closest('.kanban-card[data-task-id]');
    if (!card || e.target.closest('[data-action], [data-next-status], [data-tag-filter]')) return;
    dragging = card;
    taskId = card.dataset.taskId;
    sourceBucketKey = card.closest('[data-bucket-key]')?.dataset.bucketKey || null;
    const touch = e.touches[0];
    originX = touch.clientX;
    originY = touch.clientY;
    const rect = card.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    started = false;
  }, { passive: true });

  board.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const touch = e.touches[0];
    const dx = touch.clientX - originX;
    const dy = touch.clientY - originY;

    if (!started && Math.sqrt(dx * dx + dy * dy) < 8) return;

    if (!started) {
      started = true;
      ghost = dragging.cloneNode(true);
      ghost.className = 'kanban-card kanban-card--ghost';
      ghost.style.width = dragging.getBoundingClientRect().width + 'px';
      ghost.style.left = originLeft + 'px';
      ghost.style.top = originTop + 'px';
      document.body.appendChild(ghost);
      dragging.classList.add('kanban-card--dragging');
      board.classList.add('kanban-board--dragging');
    }

    e.preventDefault();
    ghost.style.left = (originLeft + dx) + 'px';
    ghost.style.top = (originTop + dy) + 'px';

    ghost.style.visibility = 'hidden';
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    ghost.style.visibility = '';

    const zone = el?.closest('[data-drop-zone]');
    board.querySelectorAll('.kanban-col__body--over').forEach((z) =>
      z.classList.remove('kanban-col__body--over')
    );
    if (zone) {
      zone.classList.add('kanban-col__body--over');
      activeZone = zone;
    } else {
      activeZone = null;
    }
  }, { passive: false });

  board.addEventListener('touchend', async () => {
    if (!dragging) return;
    const zone = activeZone;
    const tid = taskId;
    const fromBucketKey = sourceBucketKey;
    const task = state.tasks.find((tk) => String(tk.id) === String(tid));
    cleanup();

    if (!zone || !task) return;
    const targetBucketKey = zone.closest('[data-bucket-key]')?.dataset.bucketKey || null;
    if (fromBucketKey && targetBucketKey && fromBucketKey !== targetBucketKey) {
      window.yuvomi.showToast(t('tasks.moveBetweenBucketsHint'), 'default');
      return;
    }
    const column = zone.dataset.dropZone;
    if (kanbanColumnOf(task) === column) return;

    await runColumnMove(task, column, container);
  }, { passive: true });

  board.addEventListener('touchcancel', cleanup, { passive: true });
}

// --------------------------------------------------------
// Verlauf (#791)
//
// Die dritte Ansicht neben Liste und Board, und die einzige, die keine Aufgaben
// zeigt, sondern Vorgänge: wer wann was abgehakt hat. Sie hängt an demselben
// `#task-list` wie die beiden anderen - eine zweite Fläche daneben hieße, dass
// jede Änderung am Seitenlayout an zwei Stellen nachgezogen werden muss.
//
// SIE BEGINNT LEER. Aufgezeichnet wird seit der Migration, und was davor
// abgehakt wurde, hat niemand aufgeschrieben. Der Leerzustand sagt das, statt
// „nichts erledigt" zu behaupten - das wäre für einen Haushalt, der seit Monaten
// Aufgaben abhakt, schlicht gelogen.
// --------------------------------------------------------

/**
 * Einträge nach dem Kalendertag der Anzeigezone bündeln.
 *
 * Über `zonedDateKey` und nicht über `completed_at.slice(0, 10)`: der
 * gespeicherte Zeitpunkt ist UTC, und ein Haken um 23:30 Ortszeit landete damit
 * westlich von UTC unter dem Tag danach - dieselbe Falle, gegen die
 * `toLocalDateKey()` in der ganzen App steht.
 */
function groupHistoryByDay(entries) {
  const groups = [];
  const index = new Map();
  for (const entry of entries) {
    const day = zonedDateKey(entry.completed_at);
    if (!index.has(day)) {
      index.set(day, { day, entries: [] });
      groups.push(index.get(day));
    }
    index.get(day).entries.push(entry);
  }
  return groups;
}

/**
 * Ein Vorgang: wer, was, wann.
 *
 * Auf der geteilten Zeilen-Grammatik (styles/list-row.css) und mit demselben
 * Avatar wie ueberall sonst - `renderAvatarStack` traegt schon die Frage, ob
 * Bild oder Initialen, und welche Textfarbe auf dieser Nutzerfarbe lesbar ist.
 * Ein eigener Avatar hier haette dieselbe Kontrastrechnung ein zweites Mal
 * anstellen muessen, und die erste hat sie beim Avatar der Mitglieder bereits
 * einmal falsch gehabt.
 */
function renderHistoryEntry(entry) {
  const name = entry.user_name || t('tasks.historyUnknownMember');
  const avatar = renderAvatarStack(
    [{ display_name: name, color: entry.user_color, avatar_data: entry.user_avatar }],
    { size: 32, maxVisible: 1 },
  );
  // Der Avatar traegt hier NICHTS bei, was nicht daneben stuende: der Name
  // steht als Text in der Metazeile. Ohne aria-hidden liest die Sprachausgabe
  // „AJ ... Alex Johnson" - derselbe Mensch zweimal, einmal als Kuerzel.
  return `
    <button type="button" class="list-row history-row" data-history-task="${entry.task_id}">
      <span class="history-row__avatar" aria-hidden="true">${avatar}</span>
      <span class="list-row__main history-row__main">
        <span class="list-row__name">${esc(entry.title)}</span>
        <span class="list-row__meta">
          ${esc(name)}${entry.is_recurring
            ? ` <i data-lucide="repeat" class="icon-sm" aria-hidden="true"></i>` : ''}
        </span>
      </span>
      <time class="history-row__time" datetime="${esc(entry.completed_at)}">${esc(formatTime(entry.completed_at))}</time>
    </button>`;
}

/** Die Personenauswahl - „Alle" plus je ein Mitglied. */
function renderHistoryPeople() {
  const chip = (id, label) => {
    const on = state.history.userId === id;
    return `<button type="button" class="group-toggle__btn${on ? ' group-toggle__btn--active' : ''}"
            data-history-user="${id === null ? '' : id}" aria-pressed="${on}">
      <span class="group-toggle__label">${esc(label)}</span>
    </button>`;
  };
  // Nur wer wirklich etwas beisteuern kann: die Housekeeping-Konten sind aus
  // /meta/options schon heraus, und ein Haushalt aus einer Person braucht die
  // Auswahl gar nicht.
  if (isSoloHousehold()) return '';
  return `
    <div class="group-toggle history-people" role="group" aria-label="${t('tasks.historyPersonFilter')}">
      ${chip(null, t('common.all'))}
      ${state.users.map((u) => chip(u.id, u.display_name)).join('')}
    </div>`;
}

/** Die Personen-Chips verdrahten - beide Zweige von renderHistory zeigen sie. */
function wireHistoryPeople(root, container) {
  root.querySelectorAll('[data-history-user]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.historyUser;
      state.history.userId = raw === '' ? null : Number(raw);
      loadHistory(container);
    });
  });
}

function renderHistory(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  if (state.history.error) {
    // Die Personenauswahl bleibt STEHEN. Ohne sie war ein Fehler unter einem
    // aktiven Personenfilter eine Sackgasse: „Erneut versuchen" schickte
    // dieselbe scheiternde Abfrage los, und es gab kein „Alle", auf das man
    // haette ausweichen koennen.
    listEl.replaceChildren();
    listEl.insertAdjacentHTML('beforeend', renderHistoryPeople());
    const errorBox = document.createElement('div');
    listEl.appendChild(errorBox);
    mountLoadError(errorBox, {
      title: t('tasks.historyLoadError'),
      description: t('common.loadErrorDescription'),
      error: state.history.error,
      retryLabel: t('common.retry'),
      onRetry: () => loadHistory(container),
    });
    wireHistoryPeople(listEl, container);
    if (window.lucide) window.lucide.createIcons({ el: listEl });
    return;
  }

  const { entries, hasMore } = state.history;
  const body = entries.length
    ? groupHistoryByDay(entries).map(({ day, entries: dayEntries }) => `
        <div class="task-group list-group">
          <h2 class="list-group__title">
            <span>${esc(historyDayLabel(day))}</span>
            <span class="list-group__count">${dayEntries.length}</span>
          </h2>
          <div class="list-rows">${dayEntries.map(renderHistoryEntry).join('')}</div>
        </div>`).join('')
    // Ein Leerzustand ohne Anlegen-Knopf: „erledige etwas" ist keine Handlung,
    // die dieser Bildschirm anbieten kann, und der Hinweis erklärt stattdessen,
    // warum hier auch in einem gut geführten Haushalt nichts stehen kann.
    : emptyStateHTML({
      icon: 'history',
      title: state.history.userId === null ? t('tasks.historyEmptyTitle') : t('tasks.historyEmptyPersonTitle'),
      description: t('tasks.historyEmptyDescription'),
      // Der Hinweis erklaert, warum der Verlauf des HAUSHALTS leer sein kann,
      // obwohl seit Monaten abgehakt wird. Unter einem Personenfilter erklaert
      // er die falsche Sache: dort ist die Antwort schlicht, dass diese Person
      // nichts abgehakt hat.
      hint: state.history.userId === null ? t('tasks.historyEmptyHint') : undefined,
    });

  listEl.replaceChildren();
  listEl.insertAdjacentHTML('beforeend', `
    ${renderHistoryPeople()}
    ${body}
    ${hasMore ? `<div class="history-more">
      <button type="button" class="btn btn--secondary" id="history-more">${t('tasks.historyLoadMore')}</button>
    </div>` : ''}
  `);
  if (window.lucide) window.lucide.createIcons({ el: listEl });
  stagger(listEl.querySelectorAll('.history-row'));

  wireHistoryPeople(listEl, container);
  listEl.querySelector('#history-more')?.addEventListener('click', (e) => {
    // Kein Zuruecksetzen noetig und keins moeglich: `loadHistory` faengt seinen
    // Fehler selbst ab und wirft nie, und danach baut `renderHistory` die
    // Flaeche samt diesem Knopf neu auf - der Spinner geht mit ihm.
    btnLoading(e.currentTarget);
    loadHistory(container, { append: true });
  });
  listEl.querySelectorAll('[data-history-task]').forEach((row) => {
    row.addEventListener('click', () => openTaskFromHistory(row.dataset.historyTask, container));
  });
}

/** Ein Verlaufseintrag führt zu seiner Aufgabe - der einzige Weg von hier weg. */
async function openTaskFromHistory(id, container) {
  try {
    const [task, reminder] = await Promise.all([loadTaskForEdit(id), loadReminderForTask(id)]);
    openTaskView(task, reminder, container);
  } catch (err) {
    window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
  }
}

/**
 * Verlauf laden. `append` hängt die nächste Seite an, alles andere fängt vorn
 * an - ein Personenwechsel darf keine Mischung aus zwei Abfragen stehen lassen.
 */
async function loadHistory(container, { append = false } = {}) {
  // Ein zweiter Aufruf, waehrend einer laeuft, WARTET auf den ersten und faehrt
  // dann selbst - er wird nicht verworfen. Ein blosses `return` hier hatte den
  // Klick auf ein Personen-Chip stillschweigend geschluckt: `userId` war schon
  // umgestellt, geladen wurde nichts, und ohne ein abschliessendes Zeichnen
  // blieb die alte Liste unter dem neu markierten Chip stehen.
  while (state.history.loading) {
    // eslint-disable-next-line no-await-in-loop
    await state.history.loading;
  }
  let release;
  state.history.loading = new Promise((r) => { release = r; });
  const params = new URLSearchParams({ limit: '50' });
  if (state.history.userId !== null) params.set('user_id', String(state.history.userId));
  if (append && state.history.cursor) {
    params.set('before_at', state.history.cursor.before_at);
    params.set('before_id', String(state.history.cursor.before_id));
  }
  try {
    const res = await api.get(`/tasks/completions?${params}`);
    state.history.entries = append ? [...state.history.entries, ...(res.data ?? [])] : (res.data ?? []);
    state.history.hasMore = !!res.has_more;
    state.history.cursor = res.next_cursor ?? null;
    state.history.error = null;
  } catch (err) {
    console.error('[Tasks] Verlauf-Ladefehler:', err.message);
    state.history.error = err;
    if (!append) { state.history.entries = []; state.history.hasMore = false; state.history.cursor = null; }
  } finally {
    state.history.loading = null;
    release();
    renderHistory(container);
  }
}

// --------------------------------------------------------
// Partielle DOM-Updates
// --------------------------------------------------------

/**
 * Tasks use start_date as a visibility boundary and due_date as their deadline.
 * A calendar selection fills both fields, but the task is rendered only on its
 * deadline (or on start_date when it has no deadline). It is not an event bar.
 */
function taskCalendarDate(task) {
  return task?.due_date || task?.start_date || null;
}

function normalizeTaskCalendarRange(first, last = first) {
  return first <= last
    ? { start_date: first, due_date: last }
    : { start_date: last, due_date: first };
}

function buildTaskMonthDays(cursor, weekStart = 1) {
  const monthStart = `${String(cursor).slice(0, 7)}-01`;
  const first = parseLocalDateKey(monthStart);
  const offset = (first.getDay() - weekStart + 7) % 7;
  const gridStart = addLocalDays(monthStart, -offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = addLocalDays(gridStart, index);
    return {
      date,
      inMonth: date.slice(0, 7) === monthStart.slice(0, 7),
      weekend: isWeekendKey(date),
    };
  });
}

function taskCalendarMonthLabel(dateKey, style = 'long') {
  return new Intl.DateTimeFormat(getLocale(), { month: style, year: style === 'long' ? 'numeric' : undefined })
    .format(parseLocalDateKey(dateKey));
}

function taskCalendarDayLabel(dateKey, weekday = 'long') {
  return new Intl.DateTimeFormat(getLocale(), {
    weekday,
    month: 'short',
    day: 'numeric',
    year: weekday === 'long' ? 'numeric' : undefined,
  }).format(parseLocalDateKey(dateKey));
}

function taskCalendarWeekdayLabel(dayIndex) {
  return new Intl.DateTimeFormat(getLocale(), { weekday: 'short' })
    .format(new Date(2024, 0, 7 + dayIndex));
}

function taskCalendarTasksOn(dateKey) {
  return sortedTasks(filteredTasks().filter((task) => taskCalendarDate(task) === dateKey));
}

function taskCalendarRangeContains(dateKey) {
  const range = state.calendarSelection;
  return !!range && dateKey >= range.start_date && dateKey <= range.due_date;
}

function renderTaskCalendarChip(task) {
  const time = task.due_time ? task.due_time.slice(0, 5) : '';
  const priority = task.priority && task.priority !== 'none'
    ? `<span class="priority-dot priority-dot--${esc(task.priority)}" aria-hidden="true"></span>`
    : '';
  return `<button type="button" class="task-calendar-chip" data-action="open-task" data-id="${task.id}"
      title="${esc(task.title)}${time ? ` - ${esc(time)}` : ''}">
    ${priority}<span class="task-calendar-chip__title">${esc(task.title)}</span>
    ${time ? `<span class="task-calendar-chip__time">${esc(time)}</span>` : ''}
  </button>`;
}

function renderTaskCalendarDay(day) {
  const tasks = taskCalendarTasksOn(day.date);
  const shown = tasks.slice(0, 1);
  const more = tasks.length - shown.length;
  const selected = taskCalendarRangeContains(day.date);
  const isToday = day.date === todayKey();
  const isFocus = day.date === state.calendarFocusDate;
  const range = state.calendarSelection;
  return `<div class="task-calendar-day${day.inMonth ? '' : ' task-calendar-day--outside'}${day.weekend ? ' task-calendar-day--weekend' : ''}${isToday ? ' task-calendar-day--today' : ''}${isFocus ? ' task-calendar-day--focus' : ''}${selected ? ' task-calendar-day--selected' : ''}${range?.start_date === day.date ? ' task-calendar-day--range-start' : ''}${range?.due_date === day.date ? ' task-calendar-day--range-end' : ''}"
      role="gridcell" data-task-calendar-cell data-date="${day.date}" aria-selected="${selected}">
    <button type="button" class="task-calendar-day__date" data-task-calendar-date="${day.date}"
      aria-label="${esc(taskCalendarDayLabel(day.date))}"${isToday ? ' aria-current="date"' : ''}>
      <span>${parseLocalDateKey(day.date).getDate()}</span>
    </button>
    <div class="task-calendar-day__tasks">${shown.map(renderTaskCalendarChip).join('')}</div>
    ${more > 0 ? `<span class="task-calendar-day__more">${esc(t('calendar.moreEvents', { count: more }))}</span>` : ''}
  </div>`;
}

function renderTaskCalendarMonthPicker(year) {
  const currentMonth = state.calendarCursor.slice(0, 7);
  const months = Array.from({ length: 12 }, (_, month) => {
    const date = new Date(year, month, 1);
    const key = `${year}-${String(month + 1).padStart(2, '0')}`;
    const label = new Intl.DateTimeFormat(getLocale(), { month: 'short' }).format(date);
    return `<button type="button" class="task-calendar-month-option${key === currentMonth ? ' task-calendar-month-option--active' : ''}"
      data-task-calendar-month="${month + 1}" data-task-calendar-year="${year}" aria-pressed="${key === currentMonth}">${esc(label)}</button>`;
  }).join('');
  return `<div class="task-calendar-month-picker__year">
      <button type="button" class="btn btn--icon btn--ghost btn--icon-sm" data-task-calendar-picker-year="-1" aria-label="${esc(t('tasks.calendarPreviousYear'))}">
        <i data-lucide="chevron-down" class="icon-sm" aria-hidden="true"></i>
      </button>
      <strong>${year}</strong>
      <button type="button" class="btn btn--icon btn--ghost btn--icon-sm" data-task-calendar-picker-year="1" aria-label="${esc(t('tasks.calendarNextYear'))}">
        <i data-lucide="chevron-up" class="icon-sm" aria-hidden="true"></i>
      </button>
    </div>
    <div class="task-calendar-month-picker__months">${months}</div>`;
}

function taskCalendarRule(task) {
  const recurrence = describeRRule(task.recurrence_rule, {
    fromCompletion: !!task.recurrence_from_completion,
  });
  if (recurrence) return recurrence;
  if (task.activity_template_name) return task.activity_template_name;
  if (task.assignment_mode === 'round_robin') return 'Round robin';
  return '';
}

function renderTaskCalendarAgendaRow(task) {
  const rule = taskCalendarRule(task);
  const time = task.due_time ? task.due_time.slice(0, 5) : '';
  const people = taskParticipants(task);
  return `<button type="button" class="task-calendar-agenda-task" data-action="open-task" data-id="${task.id}">
    <span class="task-calendar-agenda-task__main">
      <span class="task-calendar-agenda-task__title">${esc(task.title)}</span>
      <span class="task-calendar-agenda-task__facts">
        ${time ? `<span>${esc(time)}</span>` : ''}
        ${Number(task.points || 0) > 0 ? `<span>${esc(t('tasks.pointsSummary', { count: Number(task.points) }))}</span>` : ''}
      </span>
      ${rule ? `<span class="task-calendar-agenda-task__rule"><i data-lucide="repeat-2" class="icon-sm" aria-hidden="true"></i>${esc(rule)}</span>` : ''}
    </span>
    ${people.length ? `<span class="task-calendar-agenda-task__people">${renderAvatarStack(people, { size: 24, maxVisible: 3 })}</span>` : ''}
  </button>`;
}

function renderTaskCalendarAgendaGroups(tasks) {
  if (!tasks.length) return `<p class="task-calendar-agenda__empty">${esc(t('tasks.kanbanColEmpty'))}</p>`;
  const buckets = taskBuckets(tasks, state.groupMode).filter((bucket) => bucket.tasks.length);
  return buckets.map((bucket) => `<div class="task-calendar-agenda-group">
    ${state.groupMode === 'none' ? '' : `<span class="task-calendar-agenda-group__label">${esc(bucket.label)}</span>`}
    ${sortedTasks(bucket.tasks).map(renderTaskCalendarAgendaRow).join('')}
  </div>`).join('');
}

function renderTaskCalendarWeekRundown() {
  const focus = state.calendarFocusDate || todayKey();
  const from = startOfLocalWeekKey(focus, state.calendarWeekStart);
  const to = addLocalDays(from, 6);
  const days = Array.from({ length: 7 }, (_, index) => addLocalDays(from, index));
  const unscheduled = sortedTasks(filteredTasks().filter((task) => !taskCalendarDate(task)));
  return `<aside class="task-calendar-agenda" aria-label="${esc(t('tasks.calendarWeekTitle'))}">
    <header class="task-calendar-agenda__header">
      <div>
        <span class="task-calendar-agenda__eyebrow">${esc(t('tasks.calendarWeekTitle'))}</span>
        <h2>${esc(t('calendar.dayRangeLabel', { from: formatDayMonth(from), to: formatDayMonth(to) }))}</h2>
      </div>
      <div class="task-calendar-agenda__nav">
        <button type="button" class="btn btn--icon btn--ghost btn--icon-sm" data-task-calendar-week="-1" aria-label="${esc(t('meals.prevWeek'))}">
          <i data-lucide="chevron-left" class="icon-sm" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn btn--icon btn--ghost btn--icon-sm" data-task-calendar-week="1" aria-label="${esc(t('meals.nextWeek'))}">
          <i data-lucide="chevron-right" class="icon-sm" aria-hidden="true"></i>
        </button>
      </div>
    </header>
    <div class="task-calendar-agenda__days">
      ${days.map((date) => {
        const tasks = taskCalendarTasksOn(date);
        return `<section class="task-calendar-agenda-day${date === focus ? ' task-calendar-agenda-day--focus' : ''}${date === todayKey() ? ' task-calendar-agenda-day--today' : ''}">
          <h3><span>${esc(taskCalendarDayLabel(date, 'short'))}</span><span>${tasks.length}</span></h3>
          ${renderTaskCalendarAgendaGroups(tasks)}
        </section>`;
      }).join('')}
    </div>
    ${unscheduled.length ? `<section class="task-calendar-unscheduled">
      <h3><i data-lucide="inbox" class="icon-sm" aria-hidden="true"></i>${esc(t('tasks.calendarUnscheduled'))}<span>${unscheduled.length}</span></h3>
      ${(state.calendarShowAllUnscheduled ? unscheduled : unscheduled.slice(0, 5)).map(renderTaskCalendarAgendaRow).join('')}
      ${!state.calendarShowAllUnscheduled && unscheduled.length > 5 ? `<button type="button" class="btn btn--ghost btn--sm task-calendar-unscheduled__more" data-task-calendar-show-unscheduled>${esc(t('calendar.moreEvents', { count: unscheduled.length - 5 }))}</button>` : ''}
    </section>` : ''}
  </aside>`;
}

function renderTaskCalendar(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;
  state.calendarEventsAbort?.abort();
  const days = buildTaskMonthDays(state.calendarCursor, state.calendarWeekStart);
  const range = state.calendarSelection;
  listEl.replaceChildren();
  listEl.insertAdjacentHTML('beforeend', `<div class="task-calendar-layout">
    <section class="task-calendar" aria-label="${esc(t('tasks.calendarView'))}">
      <header class="task-calendar__header">
        <div class="task-calendar__navigation">
          <button type="button" class="btn btn--icon btn--ghost" data-task-calendar-month-shift="-1" aria-label="${esc(t('datepicker.previousMonth'))}">
            <i data-lucide="chevron-left" class="icon-md" aria-hidden="true"></i>
          </button>
          <div class="task-calendar__month-control">
            <button type="button" class="task-calendar__month-button" data-task-calendar-picker-toggle aria-expanded="false" aria-controls="task-calendar-month-picker">
              <span>${esc(taskCalendarMonthLabel(state.calendarCursor))}</span>
              <i data-lucide="chevron-down" class="icon-sm" aria-hidden="true"></i>
            </button>
            <div class="task-calendar-month-picker" id="task-calendar-month-picker" hidden>
              ${renderTaskCalendarMonthPicker(state.calendarPickerYear)}
            </div>
          </div>
          <button type="button" class="btn btn--icon btn--ghost" data-task-calendar-month-shift="1" aria-label="${esc(t('datepicker.nextMonth'))}">
            <i data-lucide="chevron-right" class="icon-md" aria-hidden="true"></i>
          </button>
          <button type="button" class="btn btn--ghost task-calendar__today" data-task-calendar-today>${esc(t('calendar.today'))}</button>
        </div>
        <p class="task-calendar__hint" data-task-calendar-selection-status aria-live="polite">
          <i data-lucide="mouse-pointer-2" class="icon-sm" aria-hidden="true"></i>
          ${range
            ? esc(t('tasks.calendarRangeSelected', { from: formatDate(range.start_date), to: formatDate(range.due_date) }))
            : esc(t('tasks.calendarSelectHint'))}
        </p>
      </header>
      <div class="task-calendar__weekdays" role="row">
        ${weekdayOrder(state.calendarWeekStart).map((index) => `<span role="columnheader">${esc(taskCalendarWeekdayLabel(index))}</span>`).join('')}
      </div>
      <div class="task-calendar__grid" role="grid" aria-label="${esc(taskCalendarMonthLabel(state.calendarCursor))}">
        ${days.map(renderTaskCalendarDay).join('')}
      </div>
    </section>
    ${renderTaskCalendarWeekRundown()}
  </div>`);
  window.lucide?.createIcons({ el: listEl });
  wireTaskCalendar(container);
}

function shiftTaskCalendarMonth(delta) {
  const cursor = parseLocalDateKey(`${state.calendarCursor.slice(0, 7)}-01`);
  cursor.setMonth(cursor.getMonth() + delta);
  state.calendarCursor = toLocalDateKey(cursor);
  state.calendarFocusDate = state.calendarCursor;
  state.calendarSelection = null;
  state.calendarPickerYear = cursor.getFullYear();
}

function paintTaskCalendarSelection(grid) {
  const range = state.calendarSelection;
  grid.querySelectorAll('[data-task-calendar-cell]').forEach((cell) => {
    const date = cell.dataset.date;
    const selected = !!range && date >= range.start_date && date <= range.due_date;
    cell.classList.toggle('task-calendar-day--selected', selected);
    cell.classList.toggle('task-calendar-day--range-start', range?.start_date === date);
    cell.classList.toggle('task-calendar-day--range-end', range?.due_date === date);
    cell.setAttribute('aria-selected', String(selected));
  });
  const status = grid.closest('.task-calendar')?.querySelector('[data-task-calendar-selection-status]');
  if (status && range) {
    status.lastChild.textContent = ` ${t('tasks.calendarRangeSelected', {
      from: formatDate(range.start_date),
      to: formatDate(range.due_date),
    })}`;
  } else if (status) {
    status.lastChild.textContent = ` ${t('tasks.calendarSelectHint')}`;
  }
}

function openTaskCalendarSelection(range, container) {
  state.calendarSelection = normalizeTaskCalendarRange(range.start_date, range.due_date);
  state.calendarFocusDate = state.calendarSelection.start_date;
  renderTaskCalendar(container);
  openTaskModal({ users: state.users, presetDates: state.calendarSelection }, container);
}

function wireTaskCalendar(container) {
  const calendar = container.querySelector('.task-calendar-layout');
  const grid = calendar?.querySelector('.task-calendar__grid');
  if (!calendar || !grid) return;
  const controller = new AbortController();
  state.calendarEventsAbort = controller;
  const { signal } = controller;
  let drag = null;
  let suppressClick = false;

  calendar.addEventListener('click', (event) => {
    const taskAction = event.target.closest('[data-action="open-task"]');
    if (taskAction) return;
    const shift = event.target.closest('[data-task-calendar-month-shift]');
    if (shift) {
      shiftTaskCalendarMonth(Number(shift.dataset.taskCalendarMonthShift));
      renderTaskCalendar(container);
      return;
    }
    if (event.target.closest('[data-task-calendar-today]')) {
      const today = todayKey();
      state.calendarCursor = `${today.slice(0, 7)}-01`;
      state.calendarFocusDate = today;
      state.calendarSelection = null;
      state.calendarPickerYear = parseLocalDateKey(today).getFullYear();
      renderTaskCalendar(container);
      return;
    }
    const week = event.target.closest('[data-task-calendar-week]');
    if (week) {
      state.calendarFocusDate = addLocalDays(state.calendarFocusDate || todayKey(), Number(week.dataset.taskCalendarWeek) * 7);
      state.calendarCursor = `${state.calendarFocusDate.slice(0, 7)}-01`;
      state.calendarPickerYear = parseLocalDateKey(state.calendarFocusDate).getFullYear();
      state.calendarSelection = null;
      renderTaskCalendar(container);
      return;
    }
    if (event.target.closest('[data-task-calendar-show-unscheduled]')) {
      state.calendarShowAllUnscheduled = true;
      renderTaskCalendar(container);
      return;
    }
    const pickerToggle = event.target.closest('[data-task-calendar-picker-toggle]');
    if (pickerToggle) {
      const panel = calendar.querySelector('#task-calendar-month-picker');
      panel.hidden = !panel.hidden;
      pickerToggle.setAttribute('aria-expanded', String(!panel.hidden));
      return;
    }
    const yearShift = event.target.closest('[data-task-calendar-picker-year]');
    if (yearShift) {
      state.calendarPickerYear += Number(yearShift.dataset.taskCalendarPickerYear);
      const panel = calendar.querySelector('#task-calendar-month-picker');
      panel.replaceChildren();
      panel.insertAdjacentHTML('beforeend', renderTaskCalendarMonthPicker(state.calendarPickerYear));
      window.lucide?.createIcons({ el: panel });
      return;
    }
    const month = event.target.closest('[data-task-calendar-month]');
    if (month) {
      const monthNumber = String(month.dataset.taskCalendarMonth).padStart(2, '0');
      state.calendarCursor = `${month.dataset.taskCalendarYear}-${monthNumber}-01`;
      state.calendarFocusDate = state.calendarCursor;
      state.calendarSelection = null;
      renderTaskCalendar(container);
      return;
    }
    const dateTarget = event.target.closest('[data-task-calendar-date], [data-task-calendar-cell]');
    if (!dateTarget) return;
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const date = dateTarget.dataset.taskCalendarDate || dateTarget.dataset.date;
    openTaskCalendarSelection({ start_date: date, due_date: date }, container);
  }, { signal });

  grid.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.pointerType === 'touch' || event.target.closest('[data-action]')) return;
    const cell = event.target.closest('[data-task-calendar-cell]');
    if (!cell) return;
    drag = { pointerId: event.pointerId, anchor: cell.dataset.date, current: cell.dataset.date, moved: false };
    state.calendarSelection = normalizeTaskCalendarRange(drag.anchor, drag.current);
    state.calendarFocusDate = drag.anchor;
    grid.setPointerCapture?.(event.pointerId);
    paintTaskCalendarSelection(grid);
  }, { signal });

  grid.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-task-calendar-cell]');
    if (!hit || !grid.contains(hit)) return;
    const date = hit.dataset.date;
    if (date === drag.current) return;
    drag.current = date;
    drag.moved = drag.moved || date !== drag.anchor;
    state.calendarSelection = normalizeTaskCalendarRange(drag.anchor, drag.current);
    state.calendarFocusDate = date;
    paintTaskCalendarSelection(grid);
  }, { signal });

  grid.addEventListener('pointerup', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const finished = drag;
    drag = null;
    grid.releasePointerCapture?.(event.pointerId);
    // Pointer capture deliberately belongs to the grid so a drag can cross
    // child cells without being lost. Browsers may consequently retarget the
    // synthetic `click` to that grid instead of the date button, though. Open
    // a one-day selection here as well, rather than relying on the later click
    // handler for mouse and pen input. Touch never enters this branch and keeps
    // its ordinary click path so vertical scrolling remains natural.
    suppressClick = true;
    openTaskCalendarSelection(normalizeTaskCalendarRange(finished.anchor, finished.current), container);
  }, { signal });

  grid.addEventListener('pointercancel', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    state.calendarSelection = null;
    paintTaskCalendarSelection(grid);
  }, { signal });

  document.addEventListener('click', (event) => {
    const panel = calendar.querySelector('#task-calendar-month-picker');
    const toggle = calendar.querySelector('[data-task-calendar-picker-toggle]');
    if (!panel || panel.hidden || panel.contains(event.target) || toggle?.contains(event.target)) return;
    panel.hidden = true;
    toggle?.setAttribute('aria-expanded', 'false');
  }, { signal });
}

function renderTaskList(container) {
  // VOR dem Ladefehler der Aufgaben: der Verlauf hat seinen eigenen Bestand und
  // seinen eigenen Fehler. Ein gescheitertes `/tasks` sagt nichts darüber, ob
  // die Vorgänge zu haben sind - stünde die Weiche danach, zeigte der Verlauf
  // den Fehler einer Abfrage, die er gar nicht braucht.
  if (state.viewMode === 'history') {
    // NEU LADEN, nicht den zwischengespeicherten Bestand neu malen. Jeder
    // schreibende Weg endet auf `loadTasks() -> renderTaskList()`, und genau
    // dort aendert sich der Verlauf mit: ein wieder geoeffneter Haken loescht
    // seinen Eintrag serverseitig. Ohne das Nachladen blieb die zurueckgenommene
    // Erledigung stehen, bis jemand die Ansicht verliess.
    loadHistory(container);
    return;
  }
  // VOR der Kanban-Weiche: nach einem Ladefehler ist `state.tasks` ebenfalls
  // leer, und beide Ansichten haengen an demselben `#task-list`. Nur die
  // Reihenfolge trennt hier „nichts angelegt" von „nicht geladen".
  if (state.loadError) {
    const listEl = container.querySelector('#task-list');
    if (listEl) {
      mountLoadError(listEl, {
        title: t('tasks.listLoadError'),
        description: t('common.loadErrorDescription'),
        error: state.loadError,
        retryLabel: t('common.retry'),
        onRetry: () => render(container, { user: state.user }),
      });
    }
    return;
  }
  if (state.viewMode === 'kanban') {
    renderKanban(container);
    return;
  }
  if (state.viewMode === 'calendar') {
    renderTaskCalendar(container);
    return;
  }
  state.calendarEventsAbort?.abort();
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;
  listEl.replaceChildren();
  listEl.insertAdjacentHTML('beforeend', renderTaskGroups(filteredTasks(), state.groupMode));
  if (window.lucide) window.lucide.createIcons({ el: listEl });
  wireResponsiveTaskTags(listEl);
  stagger(listEl.querySelectorAll('.swipe-row, .kanban-card'));
  updateBulkActionsBar(container);
  wireSwipeGestures(container);
  maybeShowSwipeHint(container);
  listEl.querySelector('#empty-cta-tasks')?.addEventListener('click', () => {
    document.querySelector('.page-fab')?.click();
  });
}

function makeRemoveSpan() {
  const rm = document.createElement('span');
  rm.className = 'filter-chip__remove';
  rm.setAttribute('aria-hidden', 'true');
  const icon = document.createElement('i');
  icon.setAttribute('data-lucide', 'x');
  icon.className = 'icon-sm';
  rm.appendChild(icon);
  return rm;
}

/**
 * Ein Filter-Chip. Immer ein <button> — die Chips schalten Filter, sind also
 * Bedienelemente und müssen fokussierbar sein und ihren Zustand melden.
 * Dokumente und Kontakte rendern dieselbe .filter-chip-Klasse ebenfalls als
 * Button mit aria-pressed; hier lag zuvor ein <span> ohne Tastaturzugang.
 *
 * pressed === null markiert Aktions-Chips (zuletzt verwendete Filter), die
 * keinen Ein/Aus-Zustand haben und daher kein aria-pressed tragen dürfen.
 */
function makeChip({ label, active = false, extraClass = '', pressed = undefined, withRemove = false }) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `filter-chip${active ? ' filter-chip--active' : ''}${extraClass ? ` ${extraClass}` : ''}`;
  if (pressed !== null) chip.setAttribute('aria-pressed', String(pressed ?? active));
  // Das Entfernen-X ist aria-hidden (Dekor im selben Button); die Entfernen-
  // Aktion muss deshalb in den Accessible Name des Chips selbst.
  if (withRemove && label != null) {
    chip.setAttribute('aria-label', t('tasks.removeFilter', { label }));
  }
  if (label != null) chip.appendChild(document.createTextNode(label));
  if (withRemove) chip.appendChild(makeRemoveSpan());
  return chip;
}

function renderLegacyFilters(container) {
  const bar   = container.querySelector('#filter-bar');
  const panel = container.querySelector('#filter-panel');
  if (!bar || !panel) return;
  const panelOpen = isTaskPopoverOpen(panel);

  const statusLabels   = STATUS_LABELS();
  const priorityLabels = PRIORITY_LABELS();
  // Im Kanban ist der Statusfilter unwirksam (die Spalten SIND der Status) und
  // wird nicht als Chip gezeigt - daher auch nicht mitzählen, sonst behauptet
  // "Filter N" einen unsichtbaren Filter (Audit P3).
  const activeCount    = (state.viewMode === 'kanban' ? 0 : state.filters.status.length)
    + state.filters.priority.length
    + state.filters.assigned_to.length
    + state.filters.tags.length;

  // ---- Chip-Leiste: nur aktive Filter + Toggle-Button ----
  bar.replaceChildren();

  // Ein Chip je gewähltem Wert, in jeder Achse. Jeder trägt seinen eigenen
  // Wert, damit das Entfernen genau diesen einen löst und nicht die ganze
  // Auswahl (#671) - vorher gab es je Achse nur einen Wert und damit einen Chip.
  if (state.viewMode !== 'kanban') {
    state.filters.status.forEach((value) => {
      const chip = makeChip({ label: statusLabels[value] ?? value, active: true, withRemove: true });
      chip.dataset.filter = 'status';
      chip.dataset.value = value;
      bar.appendChild(chip);
    });
  }
  state.filters.priority.forEach((value) => {
    const chip = makeChip({ label: priorityLabels[value] ?? value, active: true, withRemove: true });
    chip.dataset.filter = 'priority';
    chip.dataset.value = value;
    bar.appendChild(chip);
  });
  // Aktive Personen-Filter — außer der eigenen ID, die deckt der dedizierte
  // „Mir zugewiesen"-Chip ab (keine Doppel-Anzeige).
  state.filters.assigned_to.forEach((value) => {
    if (state.currentUserId != null && Number(value) === Number(state.currentUserId)) return;
    const u = state.users.find((user) => user.id === Number(value));
    const chip = makeChip({
      label: u?.display_name ?? t('tasks.filterGroupPerson'),
      active: true,
      withRemove: true,
    });
    chip.dataset.filter = 'assigned_to';
    chip.dataset.value = value;
    bar.appendChild(chip);
  });
  // Ein Chip je gewähltem Tag. Jeder trägt seinen eigenen Wert, damit das
  // Entfernen genau diesen einen löst und nicht die ganze Auswahl.
  state.filters.tags.forEach((tag) => {
    const chip = makeChip({ label: tag, active: true, withRemove: true });
    chip.dataset.filter = 'tag';
    chip.dataset.value = tag;
    bar.appendChild(chip);
  });

  // "Mir zugewiesen" Schnellzugriff — nur sinnvoll bei mehreren Familienmitgliedern.
  // Icon+Label bewusst identisch zum Kalender-Toggle (gleiche Fähigkeit, eine Gestalt).
  if (state.users.length > 1 && state.currentUserId != null) {
    const meActive = isAssignedToMe();
    const meChip = makeChip({ label: null, active: meActive, extraClass: 'filter-chip--toggle' });
    meChip.id = 'filter-assigned-me';
    const meIcon = document.createElement('i');
    meIcon.setAttribute('data-lucide', 'user');
    meIcon.className = 'icon-sm';
    meIcon.setAttribute('aria-hidden', 'true');
    const meLabel = document.createElement('span');
    meLabel.textContent = t('tasks.assignedToMe');
    meChip.append(meIcon, meLabel);
    if (meActive) meChip.appendChild(makeRemoveSpan());
    bar.appendChild(meChip);
  }

  // "Geplante anzeigen" Toggle-Chip — Icon+Label wie „Mir zugewiesen" (beide Toggles).
  const futureChip = makeChip({ label: null, active: state.showFuture, extraClass: 'filter-chip--toggle' });
  futureChip.id = 'filter-show-future';
  const futureIcon = document.createElement('i');
  futureIcon.setAttribute('data-lucide', 'calendar-clock');
  futureIcon.className = 'icon-sm';
  futureIcon.setAttribute('aria-hidden', 'true');
  const futureLabel = document.createElement('span');
  futureLabel.textContent = t('tasks.showFuture');
  futureChip.append(futureIcon, futureLabel);
  if (state.showFuture) {
    futureChip.appendChild(makeRemoveSpan());
  }
  bar.appendChild(futureChip);

  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'filter-toggle-btn';
  // `filter-chip` trägt die Form, `filter-toggle-btn` nur noch die Abweichung:
  // der Knopf stand mit einer eigenen, zeichengleichen Kopie derselben vierzehn
  // Deklarationen daneben (siehe tasks.css) und war damit der vierte Chip, den
  // die geteilte Datei eigentlich abgelöst hat.
  toggleBtn.className = `filter-chip filter-toggle-btn${panelOpen ? ' filter-toggle-btn--open' : ''}${activeCount > 0 ? ' filter-toggle-btn--active' : ''}`;
  toggleBtn.setAttribute('aria-expanded', String(panelOpen));
  toggleBtn.setAttribute('aria-controls', 'filter-panel');

  const iconWrap = document.createElement('i');
  iconWrap.setAttribute('data-lucide', 'sliders-horizontal');
  iconWrap.className = 'icon-sm';
  iconWrap.setAttribute('aria-hidden', 'true');
  toggleBtn.appendChild(iconWrap);

  const label = document.createElement('span');
  label.textContent = t('tasks.filterBtn');
  toggleBtn.appendChild(label);

  if (activeCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'filter-toggle-btn__count';
    badge.textContent = String(activeCount);
    toggleBtn.appendChild(badge);
  }

  bar.appendChild(toggleBtn);

  // ---- Zuletzt verwendete Filter als Quick-Chips ----
  const statusLabelsMap   = STATUS_LABELS();
  const priorityLabelsMap = PRIORITY_LABELS();
  const recent = getRecentFilters();
  recent.forEach((f) => {
    const parts = [];
    // Jeder Wert jeder Achse wird benannt: seit #671 kann ein gemerktes Set
    // "Hoch" UND "Mittel" enthalten, und ein Chip, der nur den ersten nennt,
    // schaltete beim Klick mehr, als er behauptet.
    f.status.forEach((v) => parts.push(statusLabelsMap[v] ?? v));
    f.priority.forEach((v) => parts.push(priorityLabelsMap[v] ?? v));
    f.assigned_to.forEach((v) => {
      const u = state.users.find((user) => user.id === Number(v));
      if (u) parts.push(u.display_name);
    });
    // Die Tags gehören in die Beschriftung, weil der Chip sie beim Klick
    // mitsetzt: ohne sie hieße ein Chip „Offen" und schaltete zusätzlich
    // Tag-Filter, die niemand am Chip ablesen kann (#586).
    parts.push(...f.tags);
    if (!parts.length) return;
    // Aktions-Chip (wendet ein Filter-Set an), kein Ein/Aus-Zustand → pressed:null.
    const chip = makeChip({ label: parts.join(' · '), extraClass: 'filter-chip--recent', pressed: null });
    chip.dataset.recentFilter = JSON.stringify(f);
    bar.appendChild(chip);
  });

  if (window.lucide) window.lucide.createIcons({ el: bar });

  // ---- Filter-Panel: Gruppen mit allen Optionen ----
  panel.hidden = false;
  panel.replaceChildren();

  {
    // Im Kanban entfällt die Status-Gruppe: die Spalten übernehmen diese
    // Achse bereits (Audit A1-07).
    const groups = [
      ...(state.viewMode !== 'kanban' ? [{
        key: 'status',
        label: t('tasks.filterGroupStatus'),
        items: FILTER_STATUSES().map((s) => ({ value: s.value, label: s.label })),
      }] : []),
      {
        key: 'priority',
        label: t('tasks.filterGroupPriority'),
        items: PRIORITIES().map((p) => ({ value: p.value, label: p.label })),
      },
    ];
    if (state.users.length > 1) {
      groups.push({
        key: 'assigned_to',
        label: t('tasks.filterGroupPerson'),
        items: state.users.map((u) => ({ value: String(u.id), label: u.display_name })),
      });
    }
    // Tags nur anbieten, wenn welche vergeben sind — ohne CalDAV-Spiegel und ohne
    // eigene Vergabe bleibt die Gruppe sonst als leere Zeile stehen (#586).
    if (state.allTags.length) {
      groups.push({
        key: 'tag',
        label: t('tasks.filterGroupTag'),
        items: state.allTags.map((entry) => ({ value: entry.tag, label: entry.tag })),
      });
    }

    groups.forEach((group) => {
      const section = document.createElement('div');
      section.className = 'filter-panel__group';
      section.setAttribute('role', 'group');
      section.setAttribute('aria-label', group.label);

      const heading = document.createElement('div');
      heading.className = 'filter-panel__label';
      heading.textContent = group.label;
      section.appendChild(heading);

      const row = document.createElement('div');
      row.className = 'filter-panel__chips';

      group.items.forEach((item) => {
        // Jede Gruppe erlaubt Mehrfachauswahl (#671); die Tags unterscheiden
        // sich nur darin, dass ihre Zugehörigkeit die Schreibweise ignoriert.
        const isActive = group.key === 'tag'
          ? hasTagFilter(item.value)
          : hasFilter(group.key, item.value);
        const chip = makeChip({ label: item.label, active: isActive, withRemove: isActive });
        chip.dataset.filter = group.key;
        chip.dataset.value = item.value;
        row.appendChild(chip);
      });

      section.appendChild(row);
      panel.appendChild(section);
    });

    if (activeCount > 0) {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'filter-panel__clear';
      clearBtn.id = 'filter-clear-all';
      clearBtn.textContent = t('tasks.filterClearAll');
      panel.appendChild(clearBtn);
    }
    if (window.lucide) window.lucide.createIcons({ el: panel });
  }

  wireFilterChips(container);
}

function renderFilters(container) {
  const toggleBtn = container.querySelector('#filter-toggle-btn');
  const panel = container.querySelector('#filter-panel');
  if (!toggleBtn || !panel) return;

  // In Kanban, status is already represented by status sections. A status
  // choice retained from List is dormant rather than an active board filter.
  const activeCount = (state.viewMode === 'kanban' ? 0 : state.filters.status.length)
    + state.filters.priority.length
    + state.filters.assigned_to.length
    + state.filters.tags.length
    + (state.showFuture ? 1 : 0);
  const panelOpen = isTaskPopoverOpen(panel);

  toggleBtn.classList.toggle('filter-toggle-btn--open', panelOpen);
  toggleBtn.classList.toggle('filter-toggle-btn--active', activeCount > 0);
  toggleBtn.setAttribute('aria-expanded', String(panelOpen));
  toggleBtn.replaceChildren();
  toggleBtn.insertAdjacentHTML('beforeend', `<i data-lucide="sliders-horizontal" class="icon-sm" aria-hidden="true"></i>
    <span class="tasks-toolbar-control__label">${esc(t('tasks.filterBtn'))}</span>
    ${activeCount > 0 ? `<span class="filter-toggle-btn__count" aria-label="${activeCount}">${activeCount}</span>` : ''}`);
  window.lucide?.createIcons({ el: toggleBtn });

  panel.hidden = false;
  panel.replaceChildren();

  const quick = document.createElement('div');
  quick.className = 'filter-panel__quick';
  quick.setAttribute('role', 'group');
  quick.setAttribute('aria-label', t('tasks.filterBtn'));

  if (state.users.length > 1 && state.currentUserId != null) {
    const meActive = isAssignedToMe();
    const meChip = makeChip({ label: null, active: meActive, extraClass: 'filter-chip--toggle' });
    meChip.id = 'filter-assigned-me';
    meChip.insertAdjacentHTML('beforeend', `<i data-lucide="user" class="icon-sm" aria-hidden="true"></i><span>${esc(t('tasks.assignedToMe'))}</span>`);
    if (meActive) meChip.appendChild(makeRemoveSpan());
    quick.appendChild(meChip);
  }

  const futureChip = makeChip({ label: null, active: state.showFuture, extraClass: 'filter-chip--toggle' });
  futureChip.id = 'filter-show-future';
  futureChip.insertAdjacentHTML('beforeend', `<i data-lucide="calendar-clock" class="icon-sm" aria-hidden="true"></i><span>${esc(t('tasks.showFuture'))}</span>`);
  if (state.showFuture) futureChip.appendChild(makeRemoveSpan());
  quick.appendChild(futureChip);
  panel.appendChild(quick);

  const groups = [
    ...(state.viewMode !== 'kanban' ? [{
      key: 'status',
      label: t('tasks.filterGroupStatus'),
      items: FILTER_STATUSES().map((item) => ({ value: item.value, label: item.label })),
    }] : []),
    {
      key: 'priority',
      label: t('tasks.filterGroupPriority'),
      items: PRIORITIES().map((item) => ({ value: item.value, label: item.label })),
    },
  ];
  if (state.users.length > 1) {
    groups.push({
      key: 'assigned_to',
      label: t('tasks.filterGroupPerson'),
      items: state.users.map((user) => ({ value: String(user.id), label: user.display_name })),
    });
  }
  if (state.allTags.length) {
    groups.push({
      key: 'tag',
      label: t('tasks.filterGroupTag'),
      items: state.allTags.map((entry) => ({ value: entry.tag, label: entry.tag })),
    });
  }

  groups.forEach((group) => {
    const section = document.createElement('div');
    section.className = 'filter-panel__group';
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', group.label);

    const heading = document.createElement('div');
    heading.className = 'filter-panel__label';
    heading.textContent = group.label;
    section.appendChild(heading);

    const row = document.createElement('div');
    row.className = 'filter-panel__chips';
    group.items.forEach((item) => {
      const active = group.key === 'tag' ? hasTagFilter(item.value) : hasFilter(group.key, item.value);
      const chip = makeChip({ label: item.label, active, withRemove: active });
      chip.dataset.filter = group.key;
      chip.dataset.value = item.value;
      row.appendChild(chip);
    });
    section.appendChild(row);
    panel.appendChild(section);
  });

  if (activeCount > 0) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'filter-panel__clear';
    clearBtn.id = 'filter-clear-all';
    clearBtn.textContent = t('tasks.filterClearAll');
    panel.appendChild(clearBtn);
  }

  window.lucide?.createIcons({ el: panel });
  wireFilterChips(container);
}

/* DIESES MODUL FUEHRT DIE ZAHL NICHT MEHR (#868).
 *
 * Das Badge beantwortet „wie viele Aufgaben im Haushalt sind ueberfaellig".
 * `state.tasks` beantwortet eine andere Frage: es ist die GEFILTERTE Liste
 * dieser Ansicht. Der Standardfilter zeigt nur `open` (schliesst also
 * „In Bearbeitung" aus), das Kanban laesst den Statusfilter ganz weg, und
 * Priorität, Zuweisung und Tags engen zusaetzlich ein. Aus dieser Liste
 * gezaehlt sprang die Zahl beim blossen Wechsel zwischen Liste und Kanban -
 * ohne dass sich an den Daten etwas geaendert haette. Dieselbe Zahl stand
 * ausserdem in zwei ZONEN: der Server rechnet in der Haushaltszone, eine
 * Client-Rechnung im Automatikmodus in der des Browsers.
 *
 * Der Server zaehlt also, und dass sich etwas geaendert hat, meldet nicht
 * dieses Modul, sondern die API-Schicht (`notifyCountedMutation` in api.js) -
 * eine Stelle statt siebzehn Schreibpfaden allein hier. Es gibt deshalb keine
 * `updateOverdueBadge()` mehr; sie hing am RENDERN und feuerte bei jedem
 * Tastenanschlag in der Suche. */

// --------------------------------------------------------
// Swipe-Gesten (Mobil: links = erledigt, rechts = bearbeiten)
// --------------------------------------------------------

const RECENT_FILTERS_KEY = 'yuvomi:recentTaskFilters';
const RECENT_FILTERS_MAX = 3;
const COLLAPSED_GROUPS_KEY = 'yuvomi:taskCollapsedGroups';
const SHOW_FUTURE_KEY = 'yuvomi:taskShowFuture';
const ASSIGNED_TO_ME_KEY = 'yuvomi:taskAssignedToMe';

// „Mir zugewiesen" ist ein Schnellzugriff auf den assigned_to-Filter mit der
// eigenen User-ID. Wird pro Gerät gemerkt und beim Laden aus dem gespeicherten
// assigned_to-Wert (== eigene ID) abgeleitet, damit Panel-Auswahl und Chip synchron bleiben.
function isAssignedToMe() {
  return state.currentUserId != null && hasFilter('assigned_to', state.currentUserId);
}

function persistAssignedToMe() {
  try { localStorage.setItem(ASSIGNED_TO_ME_KEY, isAssignedToMe() ? '1' : '0'); } catch {}
}

/** Ist dieser Tag gerade gefiltert? Schreibweise zählt dabei nicht. */
function hasTagFilter(tag) {
  const key = String(tag).toLowerCase();
  return state.filters.tags.some((active) => active.toLowerCase() === key);
}

/**
 * Tag im Filter an- oder abwählen. Mehrere Tags engen UND-verknüpft ein, also
 * fügt ein Klick hinzu statt zu ersetzen.
 */
async function toggleTagFilter(tag, container) {
  const key = String(tag).toLowerCase();
  state.filters.tags = hasTagFilter(tag)
    ? state.filters.tags.filter((active) => active.toLowerCase() !== key)
    : [...state.filters.tags, tag];
  if (state.filters.tags.length) saveRecentFilter(state.filters);
  renderFilters(container);
  await loadTasks(container);
}

/**
 * Ein gespeichertes Filter-Set auf die aktuelle Form bringen.
 *
 * Einzelne Strings stammen aus Einträgen, die vor der jeweiligen Mehrfachauswahl
 * im localStorage gelandet sind - `tag` vor der Tag-Auswahl, `status`,
 * `priority` und `assigned_to` vor #671. Ohne die Umschreibung wären das dort
 * keine Arrays, und der erste `.includes` darauf risse die Seite auf, für Werte,
 * die niemand mehr absichtlich gesetzt hat.
 */
function normalizeFilterSet(f = {}) {
  const asList = (value) => (Array.isArray(value) ? value : (value ? [value] : [])).filter(Boolean).map(String);
  return {
    status:      asList(f.status),
    priority:    asList(f.priority),
    assigned_to: asList(f.assigned_to),
    tags:        asList(Array.isArray(f.tags) ? f.tags : (f.tag ? [f.tag] : [])),
  };
}

/** Ist dieser Wert in der Achse gerade gewählt? */
function hasFilter(key, value) {
  return (state.filters[key] || []).includes(String(value));
}

/**
 * Wert einer ODER-Achse an- oder abwählen. Ein Klick ergänzt, statt zu
 * ersetzen - sonst bliebe es bei einem Wert pro Reihe (#671).
 */
async function toggleValueFilter(key, value, container) {
  const current = state.filters[key] || [];
  const next = String(value);
  state.filters[key] = current.includes(next)
    ? current.filter((v) => v !== next)
    : [...current, next];
  if (state.filters[key].length) saveRecentFilter(state.filters);
  renderFilters(container);
  await loadTasks(container);
}

function getRecentFilters() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_FILTERS_KEY) ?? '[]').map(normalizeFilterSet);
  } catch { return []; }
}

function saveRecentFilter(filters) {
  const set = normalizeFilterSet(filters);
  if (!set.status.length && !set.priority.length && !set.assigned_to.length && !set.tags.length) return;
  // Jede Achse gehört mit allen ihren Werten in den Schlüssel: sonst verdrängte
  // „Offen + Garten" den Eintrag „Offen + Haus", weil beide auf dieselbe Kennung
  // fielen - seit #671 gilt dasselbe für zwei Prioritäten statt einer.
  const axis = (values) => [...values].map((v) => String(v).toLowerCase()).sort().join(',');
  const keyOf = (f) => [f.status, f.priority, f.assigned_to, f.tags].map(axis).join('|');
  const key = keyOf(set);
  const recent = getRecentFilters().filter((f) => keyOf(f) !== key);
  recent.unshift(set);
  try { localStorage.setItem(RECENT_FILTERS_KEY, JSON.stringify(recent.slice(0, RECENT_FILTERS_MAX))); } catch {}
}

function wireSwipeGestures(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  wireSwipeRows(listEl, {
    card: '.task-card',
    // Vor 2.0.0 öffnete derselbe Wisch hier den Bearbeiten-Dialog: eine der
    // zwei Listen, in denen die Seiten wirklich getauscht haben.
    sidesSwapped: true,
    // Zeilenanfang: Status umschalten - die primäre positive Aktion der Liste
    // (§2: dieselbe Kante trägt sie in jeder Liste). Die Karte fliegt hinaus,
    // weil die Zeile danach in einer anderen Gruppe steht - ohne den Flug
    // spränge sie einfach weg.
    leading: {
      reveal: '.swipe-reveal--done',
      flyOut: true,
      run: async (row) => {
        const taskId = row.dataset.swipeId;
        const capturedStatus = row.dataset.swipeStatus;
        const nextStatus = capturedStatus === 'done' ? 'open' : 'done';
        try {
          await toggleTaskStatus(taskId, capturedStatus);
          await loadTasks(container);
          window.yuvomi.showToast(
            t(nextStatus === 'done' ? 'tasks.swipedDoneToast' : 'tasks.swipedOpenToast'),
            'default',
            5000,
            async () => {
              try {
                await toggleTaskStatus(taskId, nextStatus);
                await loadTasks(container);
              } catch (err) {
                window.yuvomi.showToast(err.message, 'danger');
              }
            },
          );
        } catch (err) {
          window.yuvomi.showToast(err.message, 'danger');
          await loadTasks(container);
        }
      },
    },
    // Zeilenende: Detailansicht - hier die sekundäre Aktion, weil die Liste
    // eine positive führt. Die Zeile bleibt, also federt die Karte zurueck.
    trailing: {
      reveal: '.swipe-reveal--edit',
      run: async (row) => {
        const taskId = row.dataset.swipeId;
        try {
          const [task, reminder] = await Promise.all([
            loadTaskForEdit(taskId),
            loadReminderForTask(taskId),
          ]);
          openTaskView(task, reminder, container);
        } catch (err) {
          window.yuvomi.showToast(t('tasks.loadError'), 'danger');
        }
      },
    },
  });
}

// --------------------------------------------------------
// Event-Verdrahtung
// --------------------------------------------------------

function isTaskPopoverOpen(panel) {
  if (!panel) return false;
  try {
    if (panel.matches(':popover-open')) return true;
  } catch {}
  return panel.dataset.fallbackOpen === 'true';
}

function syncTaskPopoverButton(container, panel) {
  const button = container.querySelector(`[aria-controls="${panel.id}"]`);
  if (!button) return;
  const open = isTaskPopoverOpen(panel);
  button.setAttribute('aria-expanded', String(open));
  button.classList.toggle('task-control-btn--open', open);
  if (button.id === 'filter-toggle-btn') button.classList.toggle('filter-toggle-btn--open', open);
}

function closeTaskPopover(container, panel) {
  if (!panel || !isTaskPopoverOpen(panel)) return;
  try {
    if (typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
    else delete panel.dataset.fallbackOpen;
  } catch {
    delete panel.dataset.fallbackOpen;
  }
  syncTaskPopoverButton(container, panel);
}

function positionTaskPopover(panel, anchor) {
  if (!panel || !anchor) return;
  const anchorRect = anchor.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const gutter = 8;
  const width = Math.min(panelRect.width || 320, window.innerWidth - gutter * 2);
  let left = document.dir === 'rtl' ? anchorRect.left : anchorRect.right - width;
  left = Math.max(gutter, Math.min(left, window.innerWidth - width - gutter));
  let top = anchorRect.bottom + gutter;
  if (top + panelRect.height > window.innerHeight - gutter && anchorRect.top > panelRect.height + gutter) {
    top = anchorRect.top - panelRect.height - gutter;
  }
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(Math.max(gutter, top))}px`;
  panel.style.maxHeight = `${Math.max(160, window.innerHeight - Math.max(gutter, top) - gutter)}px`;
}

function openTaskControlPopover(container, panel, anchor) {
  if (!panel || !anchor) return;
  container.querySelectorAll('.task-control-popover').forEach((other) => {
    if (other !== panel) closeTaskPopover(container, other);
  });
  if (!panel.dataset.taskPopoverWired) {
    panel.dataset.taskPopoverWired = 'true';
    panel.addEventListener('toggle', () => syncTaskPopoverButton(container, panel));
  }
  try {
    if (typeof panel.showPopover === 'function') panel.showPopover();
    else panel.dataset.fallbackOpen = 'true';
  } catch {
    panel.dataset.fallbackOpen = 'true';
  }
  syncTaskPopoverButton(container, panel);
  requestAnimationFrame(() => positionTaskPopover(panel, anchor));
}

function toggleTaskControlPopover(container, panel, anchor) {
  if (isTaskPopoverOpen(panel)) closeTaskPopover(container, panel);
  else openTaskControlPopover(container, panel, anchor);
}

function wireFilterChips(container) {
  // The toolbar button survives renderFilters(); wire it once while the
  // option chips below are safely rewired after panel.replaceChildren().
  const toggle = container.querySelector('#filter-toggle-btn');
  if (toggle && !toggle.dataset.taskFilterWired) {
    toggle.dataset.taskFilterWired = 'true';
    toggle.addEventListener('click', (event) => {
      toggleTaskControlPopover(container, container.querySelector('#filter-panel'), event.currentTarget);
    });
  }

  // Alle Filter zurücksetzen
  container.querySelector('#filter-clear-all')?.addEventListener('click', async () => {
    state.filters = { status: [], priority: [], assigned_to: [], tags: [] };
    state.showFuture = false;
    try { localStorage.setItem(SHOW_FUTURE_KEY, '0'); } catch {}
    persistAssignedToMe();
    renderFilters(container);
    await loadTasks(container);
  });

  // "Geplante anzeigen" Toggle
  container.querySelector('#filter-show-future')?.addEventListener('click', async () => {
    state.showFuture = !state.showFuture;
    try { localStorage.setItem(SHOW_FUTURE_KEY, state.showFuture ? '1' : '0'); } catch {}
    renderFilters(container);
    await loadTasks(container);
  });

  // "Mir zugewiesen" Toggle — nimmt die eigene ID in den Personen-Filter auf
  // bzw. wieder heraus. Seit #671 eine Achse mit mehreren Werten: eine bereits
  // gewählte zweite Person bleibt dabei stehen, statt still zu verschwinden.
  container.querySelector('#filter-assigned-me')?.addEventListener('click', async () => {
    await toggleValueFilter('assigned_to', state.currentUserId, container);
  });

  // Chip-Klicks (in Bar + Panel)
  container.querySelectorAll('[data-filter]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const filter = chip.dataset.filter;
      if (filter === 'tag') {
        await toggleTagFilter(chip.dataset.value, container);
        return;
      }
      await toggleValueFilter(filter, chip.dataset.value, container);
    });
  });

  // Recent-Filter-Chips anwenden
  container.querySelectorAll('[data-recent-filter]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      try {
        state.filters = normalizeFilterSet(JSON.parse(chip.dataset.recentFilter));
      } catch { return; }
      renderFilters(container);
      await loadTasks(container);
    });
  });
}

/**
 * Alles am Seitenkopf, was von der gewaehlten Ansicht abhaengt - an EINER
 * Stelle.
 *
 * Vorher stand dieselbe Bedingung zweimal da: einmal als Interpolation im
 * Anfangs-Markup, einmal im Klick-Handler des Umschalters. Mit zwei Ansichten
 * ging das gerade noch gut; mit der dritten waeren es zwei Listen gewesen, die
 * auseinanderlaufen koennen, und eine davon haette den Verlauf vergessen.
 *
 * Sichtbarkeit ueber [hidden] statt style.display: ein Zustand, den auch
 * assistive Technik als „nicht vorhanden" liest.
 */
function syncViewChrome(container) {
  const mode = state.viewMode;
  const isList = mode === 'list';
  const isHistory = mode === 'history';

  renderTaskViewPanel(container);

  // Der Kopf fluchtet mit dem Koerper, den er ueberschreibt - und der wechselt
  // hier die Breite. Liste und Verlauf sind aufs Lesemass gekappt (720px), das
  // Kanban-Board nimmt die volle Content-Spalte (gemessen 1156px bei 1440px
  // Fensterbreite); ein fester Modifier im Markup stimmte in genau einer der
  // Ansichten (Critique 2026-08-13).
  container.querySelector('.tasks-toolbar')?.classList.toggle('page-toolbar--narrow', !isWideTaskView());

  // Suche, Filterleiste, Gruppierung und Sammelauswahl fragen alle nach
  // AUFGABEN. Der Verlauf zeigt Vorgaenge - ein Statusfilter darueber waere
  // eine Auswahl, die nichts veraendern kann.
  const search = container.querySelector('.tasks-toolbar__search');
  if (search) search.hidden = isHistory;
  const filterButton = container.querySelector('#filter-toggle-btn');
  if (filterButton) filterButton.hidden = isHistory;
  // Das aufgeklappte Filter-Panel ist ein GESCHWISTER der Zeile, kein Kind -
  // die Zeile zu verstecken laesst es stehen, und dann schwebten Status- und
  // Prioritaets-Chips ueber einer Liste von Vorgaengen.
  if (isHistory) {
    container.querySelectorAll('.task-control-popover').forEach((panel) => closeTaskPopover(container, panel));
  }
  const groupButton = container.querySelector('#group-mode-toggle');
  if (groupButton) groupButton.hidden = isHistory;
  const sortButton = container.querySelector('#task-sort-btn');
  if (sortButton) sortButton.hidden = isHistory;
  const bulkSelectBtn = container.querySelector('#btn-bulk-select');
  if (bulkSelectBtn) {
    bulkSelectBtn.hidden = !isList;
    if (!isList) {
      state.bulkSelectMode = false;
      state.selectedTaskIds.clear();
      bulkSelectBtn.classList.remove('btn--active');
      bulkSelectBtn.setAttribute('aria-pressed', 'false');
    }
  }
  // Die Auswahl zu LEEREN raeumt die Leiste nicht weg: sie haengt an
  // `bar.hidden`, das nur updateBulkActionsBar setzt. Ohne diesen Aufruf blieb
  // „Als erledigt markieren / Ablegen / Loeschen" ueber dem Verlauf stehen -
  // mit leerer Auswahl, also Knoepfe ohne Gegenstand.
  updateBulkActionsBar(container);
}

/** Nimmt die Ansicht die volle Content-Spalte ein? */
function isWideTaskView() {
  return state.viewMode === 'kanban' || state.viewMode === 'calendar';
}

function wireLegacyViewToggle(container) {
  const toggle = container.querySelector('#view-toggle');
  if (!toggle) return;
  syncViewChrome(container);
  toggle.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // A control panel belongs to the layout that opened it. Keeping it open
      // while moving between List, Kanban, and History leaves an orphaned
      // menu over controls whose meaning (especially Group) has just changed.
      container.querySelectorAll('.task-control-popover').forEach((panel) => {
        closeTaskPopover(container, panel);
      });
      state.viewMode = btn.dataset.view;
      localStorage.setItem('yuvomi-tasks-view', state.viewMode);
      syncActiveGroupMode();
      persistTaskLayoutState();
      renderFilters(container);
      renderTaskControlPanels(container);
      syncViewChrome(container);

      // Skeleton-Flash: einen Frame Render-Feedback geben, dann Ansicht aufbauen
      const listEl = container.querySelector('#task-list');
      if (listEl) listEl.style.opacity = '0.4';
      const restore = () => {
        const el = container.querySelector('#task-list');
        if (el) { el.style.transition = 'opacity 0.15s'; el.style.opacity = ''; }
      };
      requestAnimationFrame(() => {
        // Der Verlauf holt Vorgaenge, die beiden anderen Ansichten Aufgaben -
        // zwei Abfragen, und der Umschalter darf nicht die falsche fahren. Ein
        // gemeinsames loadTasks() haette den Verlauf mit einer Aufgabenliste
        // befuellt, die er gar nicht anzeigt.
        if (state.viewMode === 'history') {
          loadHistory(container).finally(restore);
          return;
        }
        // Task-Menge neu laden: der Kanban lädt alle Stati (kein status-Param),
        // die Liste wendet den Statusfilter wieder an (Audit A1-07/P3). Fällt bei
        // Netzfehler auf ein reines Re-Render der vorhandenen Aufgaben zurück.
        loadTasks(container).catch(() => renderTaskList(container)).finally(() => {
          updateBulkActionsBar(container);
          restore();
        });
      });
    });
  });
}

function taskViewValue() {
  return state.viewMode;
}

function TASK_VIEW_OPTIONS() {
  return [
    { value: 'list', label: t('tasks.listView'), icon: 'list' },
    { value: 'kanban', label: t('tasks.kanbanView'), icon: 'columns-3' },
    { value: 'calendar', label: t('tasks.calendarView'), icon: 'calendar-days' },
    // History remains available, but it is no longer a competing segmented
    // control permanently occupying the Tasks header.
    { value: 'history', label: t('tasks.historyView'), icon: 'history' },
  ];
}

function renderTaskViewPanel(container) {
  const panel = container.querySelector('#task-view-panel');
  const anchor = container.querySelector('#task-view-btn');
  if (!panel || !anchor) return;
  const selected = taskViewValue();
  const selectedOption = TASK_VIEW_OPTIONS().find((item) => item.value === selected);
  anchor.title = selectedOption?.label || t('tasks.viewToggleLabel');
  panel.replaceChildren();
  panel.insertAdjacentHTML('beforeend', `<section class="task-control-section">
    <h3>${esc(t('tasks.viewToggleLabel'))}</h3>
    ${renderTaskChoiceButtons(TASK_VIEW_OPTIONS(), selected, 'data-task-view')}
  </section>`);
  window.lucide?.createIcons({ el: panel });
}

function activateTaskView(container, value) {
  const nextMode = value;

  container.querySelectorAll('.task-control-popover').forEach((panel) => closeTaskPopover(container, panel));
  state.viewMode = nextMode;
  state.boardScope = deviceTaskBoardScope();
  localStorage.setItem('yuvomi-tasks-view', state.viewMode);
  syncActiveGroupMode();
  persistTaskLayoutState();
  renderFilters(container);
  renderTaskControlPanels(container);
  syncViewChrome(container);

  const listEl = container.querySelector('#task-list');
  if (listEl) listEl.style.opacity = '0.4';
  const restore = () => {
    const el = container.querySelector('#task-list');
    if (el) { el.style.transition = 'opacity 0.15s'; el.style.opacity = ''; }
  };
  requestAnimationFrame(() => {
    if (state.viewMode === 'history') {
      loadHistory(container).finally(restore);
      return;
    }
    loadTasks(container).catch(() => renderTaskList(container)).finally(() => {
      updateBulkActionsBar(container);
      restore();
    });
  });
}

function wireViewToggle(container) {
  const anchor = container.querySelector('#task-view-btn');
  const panel = container.querySelector('#task-view-panel');
  if (!anchor || !panel) return;
  renderTaskViewPanel(container);
  syncViewChrome(container);
  anchor.addEventListener('click', (event) => {
    renderTaskViewPanel(container);
    toggleTaskControlPopover(container, panel, event.currentTarget);
  });
  panel.addEventListener('click', (event) => {
    const option = event.target.closest('[data-task-view]');
    if (!option) return;
    activateTaskView(container, option.dataset.taskView);
  });
}

function renderTaskChoiceButtons(items, currentValue, dataAttribute) {
  return `<div class="task-control-options">${items.map((item) => `<button type="button"
      class="task-control-option${item.value === currentValue ? ' task-control-option--active' : ''}"
      ${dataAttribute}="${esc(item.value)}" aria-pressed="${item.value === currentValue}">
      ${item.icon ? `<i data-lucide="${item.icon}" class="icon-sm" aria-hidden="true"></i>` : ''}
      <span>${esc(item.label)}</span>
      ${item.value === currentValue ? '<i data-lucide="check" class="icon-sm task-control-option__check" aria-hidden="true"></i>' : ''}
    </button>`).join('')}</div>`;
}

function renderTaskGroupPanel(container) {
  const panel = container.querySelector('#task-group-panel');
  if (!panel) return;
  const anchor = container.querySelector('#group-mode-toggle');
  if (anchor) {
    anchor.dataset.mode = state.groupMode;
  }
  const fields = GROUP_FIELDS().filter((field) => state.viewMode !== 'kanban' || field.value !== 'status');
  panel.replaceChildren();
  panel.insertAdjacentHTML('beforeend', `<section class="task-control-section">
      <h3>${esc(t('tasks.groupBy'))}</h3>
      ${renderTaskChoiceButtons(fields, state.groupMode, 'data-task-group')}
    </section>
    <section class="task-control-section">
      <h3>${esc(t('tasks.progressDisplay'))}</h3>
      ${renderTaskChoiceButtons(PROGRESS_MODES(), state.progressMode, 'data-task-progress')}
    </section>`);
  if (window.lucide) window.lucide.createIcons({ el: panel });
}

function activeBucketSort(bucketKey) {
  return bucketKey ? (state.bucketSorts.get(bucketKey) || state.sheetSort) : state.sheetSort;
}

function renderTaskSortPanel(container, bucketKey = null) {
  const panel = container.querySelector('#task-sort-panel');
  if (!panel) return;
  if (bucketKey) panel.dataset.bucketKey = bucketKey;
  else delete panel.dataset.bucketKey;
  const selected = activeBucketSort(bucketKey);
  const local = bucketKey ? state.bucketSorts.get(bucketKey) : null;
  panel.replaceChildren();
  panel.insertAdjacentHTML('beforeend', `<section class="task-control-section">
      <div class="task-sort-header">
        <h3>${esc(bucketKey ? t('tasks.bucketSort') : t('tasks.sheetSort'))}</h3>
        <div class="task-sort-header__actions">
          <div class="task-sort-directions" role="group" aria-label="${esc(t('tasks.sortDirection'))}">
            ${[
              { value: 'asc', label: t('tasks.sortAscending'), icon: 'arrow-up' },
              { value: 'desc', label: t('tasks.sortDescending'), icon: 'arrow-down' },
            ].map((direction) => `<button type="button"
              class="btn btn--ghost btn--icon btn--icon-sm task-sort-direction${direction.value === selected.direction ? ' task-sort-direction--active' : ''}"
              data-task-sort-direction="${direction.value}" aria-pressed="${direction.value === selected.direction}"
              aria-label="${esc(direction.label)}" title="${esc(direction.label)}">
              <i data-lucide="${direction.icon}" class="icon-sm" aria-hidden="true"></i>
            </button>`).join('')}
          </div>
          ${bucketKey ? `<button type="button"
            class="btn btn--ghost btn--icon btn--icon-sm task-sort-lock${local?.locked ? ' task-sort-lock--active' : ''}"
            data-task-sort-lock aria-pressed="${!!local?.locked}"
            aria-label="${esc(local?.locked ? t('tasks.bucketSortInherit') : t('tasks.bucketSortKeep'))}"
            title="${esc(local?.locked ? t('tasks.bucketSortInherit') : t('tasks.bucketSortKeep'))}">
            <i data-lucide="${local?.locked ? 'lock' : 'lock-open'}" class="icon-sm" aria-hidden="true"></i>
          </button>` : ''}
        </div>
      </div>
      ${renderTaskChoiceButtons(SORT_FIELDS(), selected.field, 'data-task-sort-field')}
    </section>
    ${bucketKey ? '' : `<p class="task-control-hint">${esc(t('tasks.sheetSortHint'))}</p>`}`);
  if (window.lucide) window.lucide.createIcons({ el: panel });
}

function renderTaskControlPanels(container) {
  renderTaskViewPanel(container);
  renderTaskGroupPanel(container);
  renderTaskSortPanel(container);
}

function removeUnlockedBucketSorts() {
  state.bucketSorts.forEach((sort, key) => {
    if (!sort.locked) state.bucketSorts.delete(key);
  });
}

function applyTaskSortChoice(container, patch) {
  const panel = container.querySelector('#task-sort-panel');
  const bucketKey = panel?.dataset.bucketKey || null;
  if (bucketKey) {
    const current = activeBucketSort(bucketKey);
    // A group-specific choice starts unlocked: it remains local until the
    // next overall Sheet Sort. The adjacent lock is what deliberately makes
    // it survive future Sheet Sort changes.
    state.bucketSorts.set(bucketKey, { ...current, ...patch, locked: !!state.bucketSorts.get(bucketKey)?.locked });
    persistTaskLayoutState();
    closeTaskPopover(container, panel);
    renderTaskList(container);
    return;
  }
  state.sheetSort = { ...state.sheetSort, ...patch };
  removeUnlockedBucketSorts();
  persistTaskLayoutState();
  renderTaskList(container);
  renderTaskSortPanel(container);
  positionTaskPopover(panel, container.querySelector('#task-sort-btn'));
}

function openTaskSortPopover(container, anchor, bucketKey = null) {
  renderTaskSortPanel(container, bucketKey);
  openTaskControlPopover(container, container.querySelector('#task-sort-panel'), anchor);
}

function wireGroupToggle(container) {
  renderTaskControlPanels(container);

  container.querySelector('#group-mode-toggle')?.addEventListener('click', (event) => {
    renderTaskGroupPanel(container);
    toggleTaskControlPopover(container, container.querySelector('#task-group-panel'), event.currentTarget);
  });
  container.querySelector('#task-sort-btn')?.addEventListener('click', (event) => {
    renderTaskSortPanel(container);
    toggleTaskControlPopover(container, container.querySelector('#task-sort-panel'), event.currentTarget);
  });

  container.querySelector('#task-group-panel')?.addEventListener('click', (event) => {
    const group = event.target.closest('[data-task-group]');
    if (group) {
      state.groupMode = group.dataset.taskGroup;
      state.groupModes[activeLayoutKey()] = state.groupMode;
      persistTaskLayoutState();
      renderTaskGroupPanel(container);
      renderTaskList(container);
      positionTaskPopover(container.querySelector('#task-group-panel'), container.querySelector('#group-mode-toggle'));
      return;
    }
    const progress = event.target.closest('[data-task-progress]');
    if (progress) {
      state.progressMode = progress.dataset.taskProgress;
      persistTaskLayoutState();
      renderTaskGroupPanel(container);
      renderTaskList(container);
      positionTaskPopover(container.querySelector('#task-group-panel'), container.querySelector('#group-mode-toggle'));
    }
  });

  container.querySelector('#task-sort-panel')?.addEventListener('click', (event) => {
    const field = event.target.closest('[data-task-sort-field]');
    if (field) {
      applyTaskSortChoice(container, { field: field.dataset.taskSortField });
      return;
    }
    const direction = event.target.closest('[data-task-sort-direction]');
    if (direction) {
      applyTaskSortChoice(container, { direction: direction.dataset.taskSortDirection });
      return;
    }
    if (event.target.closest('[data-task-sort-lock]')) {
      const panel = container.querySelector('#task-sort-panel');
      const bucketKey = panel?.dataset.bucketKey;
      if (!bucketKey) return;
      const local = state.bucketSorts.get(bucketKey);
      if (local?.locked) state.bucketSorts.delete(bucketKey);
      else state.bucketSorts.set(bucketKey, { ...activeBucketSort(bucketKey), locked: true });
      persistTaskLayoutState();
      closeTaskPopover(container, panel);
      renderTaskList(container);
    }
  });
}

function wireNewTaskBtn(container) {
  const handler = () => {
    openTaskModal({ users: state.users }, container);
  };
  container.querySelector('#btn-new-task')?.addEventListener('click', handler);
  findPageFab('fab-new-task')?.addEventListener('click', handler);
}

function wireQuickAddBtn(container) {
  container.querySelector('#btn-quick-add')?.addEventListener('click', () => {
    container.querySelectorAll('.task-control-popover').forEach((panel) => closeTaskPopover(container, panel));
    openQuickAdd({
      onCreated: async () => loadTasks(container),
      onActivitySelected: async (activity) => {
        openTaskModal({ users: state.users, presetActivityTemplate: activity }, container);
      },
    });
  });
}

function placeSelectOptions(selected = null) {
  return state.places.filter((place) => place.active !== 0).map((place) =>
    `<option value="${place.id}" ${Number(selected) === Number(place.id) ? 'selected' : ''}>${esc(place.path_label || place.name)}</option>`
  ).join('');
}

function googleAttributionHtml(result) {
  const thirdParty = (result.attributions || []).map((attribution) => {
    const name = attribution?.displayName || attribution?.provider || attribution?.name;
    const uri = attribution?.uri || attribution?.providerUri;
    if (!name) return '';
    if (typeof uri === 'string' && /^https:\/\//i.test(uri)) {
      return `<a href="${esc(uri)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>`;
    }
    return esc(name);
  }).filter(Boolean);
  return `<small class="form-hint">Results from Google Maps${thirdParty.length ? ` · Attribution: ${thirdParty.join(', ')}` : ''}</small>`;
}

function renderTaskLocationFields(task = null) {
  const location = task?.location || null;
  const kind = location?.kind || 'none';
  const origin = state.places.find((place) => place.type === 'home') || state.places[0];
  const searchConfigured = Boolean(state.placeSearchStatus?.configured);
  const setupMessage = 'Google place search is off. An administrator must configure GOOGLE_MAPS_API_KEY, enable the integration, and accept the Google Maps terms. You can still save ordinary addresses.';
  return `<fieldset class="form-group task-location" id="task-location-fieldset">
    <legend class="label">Location</legend>
    <select class="input" id="task-location-kind" name="location_kind">
      <option value="none" ${kind === 'none' ? 'selected' : ''}>No location</option>
      <option value="saved_place" ${kind === 'saved_place' ? 'selected' : ''}>Saved Yuvomi Place</option>
      <option value="manual" ${kind === 'manual' ? 'selected' : ''}>One-use manual location</option>
      <option value="google_place" ${kind === 'google_place' ? 'selected' : ''}>Find a business or place</option>
    </select>
    <div data-location-pane="saved_place" style="margin-top:var(--space-3)">
      <select class="input" id="task-location-place"><option value="">Choose a saved Place</option>${placeSelectOptions(location?.place_id)}</select>
      <p class="task-field-hint">Reusable locations are maintained in Address Book → Places.</p>
    </div>
    <div data-location-pane="manual" style="margin-top:var(--space-3)">
      <input class="input" id="task-location-label" maxlength="120" placeholder="Location name" value="${esc(kind === 'manual' ? location?.label || '' : '')}">
      <textarea class="input" id="task-location-address" rows="2" placeholder="Address or directions" style="margin-top:var(--space-2)">${esc(kind === 'manual' ? location?.address || '' : '')}</textarea>
      <details style="margin-top:var(--space-2)"><summary class="task-field-hint">Advanced coordinates (optional)</summary><div class="modal-grid modal-grid--2" style="margin-top:var(--space-2)"><input class="input" id="task-location-latitude" type="number" step="any" min="-90" max="90" placeholder="Latitude" value="${kind === 'manual' && location?.latitude != null ? location.latitude : ''}"><input class="input" id="task-location-longitude" type="number" step="any" min="-180" max="180" placeholder="Longitude" value="${kind === 'manual' && location?.longitude != null ? location.longitude : ''}"></div></details>
    </div>
    <div data-location-pane="google_place" style="margin-top:var(--space-3)">
      <p class="task-field-hint"><strong>Privacy:</strong> your search text and selected origin are sent to Google through this Yuvomi server. Search runs only when you press Search.</p>
      <div class="modal-grid modal-grid--2"><input class="input" id="task-place-query" minlength="3" maxlength="120" placeholder="UPS Store, pharmacy, dentist…"><select class="input" id="task-place-category"><option value="">Any type</option><option value="pharmacy">Pharmacy</option><option value="restaurant">Restaurant</option><option value="dentist">Dentist</option><option value="lodging">Hotel / lodging</option><option value="store">Store</option></select></div>
      <select class="input" id="task-place-origin-mode" style="margin-top:var(--space-2)"><option value="saved">Near a saved Place</option><option value="text">Near an address, city, or ZIP</option><option value="anywhere">No specific origin</option></select>
      <div data-origin-pane="saved" style="margin-top:var(--space-2)"><select class="input" id="task-place-origin"><option value="">Choose search origin</option>${placeSelectOptions(origin?.id)}</select></div>
      <div data-origin-pane="text" style="margin-top:var(--space-2)" hidden><input class="input" id="task-origin-text" maxlength="160" placeholder="Address, city, or ZIP (for example, 27513)"></div>
      <div data-origin-pane="anywhere" hidden></div>
      <button class="btn btn--secondary btn--sm" type="button" id="task-place-search" style="margin-top:var(--space-2)" ${searchConfigured ? '' : 'disabled'}><i data-lucide="search" class="icon-sm"></i>Search Google Places</button>
      <p class="task-field-hint" id="task-place-search-status">${searchConfigured ? `${state.placeSearchStatus.usage?.household_today ?? 0} of ${state.placeSearchStatus.limits?.household_per_day ?? 100} household searches used today.` : setupMessage}</p>
      <input type="hidden" id="task-location-external-id" value="${esc(kind === 'google_place' ? location?.external_place_id || '' : '')}">
      <input type="hidden" id="task-location-external-label" value="${esc(kind === 'google_place' ? location?.label || '' : '')}">
      <div id="task-place-selected" class="task-field-hint">${kind === 'google_place' ? `Selected for this Task: <strong>${esc(location?.label || 'Google place')}</strong>` : ''}</div>
      <div id="task-place-results" class="automation-list" style="margin-top:var(--space-2)"></div>
    </div>
  </fieldset>`;
}

function readTaskLocation(form) {
  const kind = form.querySelector('#task-location-kind')?.value || 'none';
  if (kind === 'none') return { kind: 'none' };
  if (kind === 'saved_place') return { kind, place_id: Number(form.querySelector('#task-location-place')?.value) || null };
  if (kind === 'manual') return {
    kind, user_label: form.querySelector('#task-location-label')?.value.trim(),
    manual_address: form.querySelector('#task-location-address')?.value.trim() || null,
    latitude: form.querySelector('#task-location-latitude')?.value || null,
    longitude: form.querySelector('#task-location-longitude')?.value || null,
  };
  return {
    kind: 'google_place', external_provider: 'google',
    external_place_id: form.querySelector('#task-location-external-id')?.value,
    user_label: form.querySelector('#task-location-external-label')?.value,
  };
}

function wireTaskLocationForm(panel) {
  const kind = panel.querySelector('#task-location-kind');
  const refresh = () => panel.querySelectorAll('[data-location-pane]').forEach((pane) => { pane.hidden = pane.dataset.locationPane !== kind?.value; });
  kind?.addEventListener('change', refresh); refresh();
  const originMode = panel.querySelector('#task-place-origin-mode');
  const refreshOrigin = () => panel.querySelectorAll('[data-origin-pane]').forEach((pane) => { pane.hidden = pane.dataset.originPane !== originMode?.value; });
  originMode?.addEventListener('change', refreshOrigin); refreshOrigin();
  const search = panel.querySelector('#task-place-search');
  search?.addEventListener('click', async () => {
    const query = panel.querySelector('#task-place-query')?.value.trim() || '';
    const status = panel.querySelector('#task-place-search-status');
    if (query.length < 3) { status.textContent = 'Enter at least three characters.'; return; }
    const body = { query, included_type: panel.querySelector('#task-place-category')?.value || null };
    if (originMode.value === 'saved') body.origin_place_id = Number(panel.querySelector('#task-place-origin')?.value) || null;
    else if (originMode.value === 'text') body.origin_text = panel.querySelector('#task-origin-text')?.value.trim() || null;
    search.disabled = true; status.textContent = 'Searching Google Places…';
    try {
      const response = await api.post('/planning/place-search', body);
      const results = response.data || [];
      status.textContent = results.length ? `${results.length} live result${results.length === 1 ? '' : 's'} from Google.` : 'No matching places found.';
      const list = panel.querySelector('#task-place-results');
      list.replaceChildren();
      results.forEach((result, index) => {
        const row = document.createElement('div');
        row.className = 'list-row automation-list-row';
        const distance = result.distance_meters == null ? '' : ` • ${(result.distance_meters / 1609.344).toFixed(1)} mi`;
        row.insertAdjacentHTML('beforeend', `<div class="automation-list-row__copy"><strong>${esc(result.display_name)}</strong><br><small class="form-hint">${esc(result.formatted_address || '')}${esc(distance)}${result.primary_type ? ` • ${esc(result.primary_type)}` : ''}</small><br>${googleAttributionHtml(result)}<input class="input" data-place-save-name="${index}" maxlength="120" value="${esc(result.display_name)}" aria-label="Yuvomi Place name"></div><div class="automation-list-row__actions"><button type="button" class="btn btn--primary btn--sm" data-use-place="${index}">Use for Task</button>${state.isAdmin ? `<button type="button" class="btn btn--secondary btn--sm" data-save-place="${index}">Save to Places</button>` : ''}</div>`);
        list.appendChild(row);
      });
      list.querySelectorAll('[data-use-place]').forEach((button) => button.addEventListener('click', () => {
        const result = results[Number(button.dataset.usePlace)];
        panel.querySelector('#task-location-external-id').value = result.external_place_id;
        panel.querySelector('#task-location-external-label').value = result.display_name;
        const selected = panel.querySelector('#task-place-selected');
        selected.replaceChildren(document.createTextNode('Selected for this Task: '));
        const name = document.createElement('strong');
        name.textContent = result.display_name;
        selected.appendChild(name);
      }));
      list.querySelectorAll('[data-save-place]').forEach((button) => button.addEventListener('click', async () => {
        const index = Number(button.dataset.savePlace); const result = results[index];
        const name = list.querySelector(`[data-place-save-name="${index}"]`)?.value.trim();
        if (!name) { status.textContent = 'Give the saved Yuvomi Place a name.'; return; }
        button.disabled = true;
        try {
          const saved = await api.post('/planning/admin/places/from-google', { external_place_id: result.external_place_id, name, type: 'custom', latitude: result.latitude, longitude: result.longitude });
          state.places.push(saved.data); kind.value = 'saved_place'; refresh();
          const select = panel.querySelector('#task-location-place');
          select.insertAdjacentHTML('beforeend', `<option value="${saved.data.id}">${esc(saved.data.path_label || saved.data.name)}</option>`); select.value = String(saved.data.id);
          status.textContent = 'Saved to Yuvomi Places and selected for this Task.';
        } catch (error) { status.textContent = error.message; button.disabled = false; }
      }));
    } catch (error) { status.textContent = error.message; }
    finally { search.disabled = false; }
  });
}

function wireAssignmentRequestsBtn(container) {
  container.querySelector('#btn-assignment-requests')?.addEventListener('click', () => {
    const content = state.assignmentRequests.length ? `<div class="automation-list">${state.assignmentRequests.map((request) => `
      <section class="list-row automation-list-row" data-assignment-request="${request.id}">
        <div class="automation-list-row__copy"><strong>${esc(request.task_title || 'Assignment request')}</strong><br><small class="form-hint">${request.status === 'accepted' ? 'Accepted' : 'Waiting for your response'}${request.response_deadline ? ` · due ${esc(request.response_deadline)}` : ''}</small></div>
        <div class="automation-list-row__actions"><button class="btn btn--ghost btn--sm" data-request-action="decline">Decline</button><button class="btn btn--primary btn--sm" data-request-action="accept">Accept</button></div>
      </section>`).join('')}</div>` : emptyStateHTML({
        icon: 'circle-check-big',
        title: 'You are all caught up',
        description: 'There are no assignment requests waiting for you.',
      });
    openSharedModal({ title: 'Assignment requests', content, size: 'md', onSave(panel) {
      panel.querySelectorAll('[data-request-action]').forEach((button) => button.addEventListener('click', async () => {
        const row = button.closest('[data-assignment-request]');
        button.disabled = true;
        try {
          await api.post(`/automation/obligations/${row.dataset.assignmentRequest}/respond`, { action: button.dataset.requestAction });
          state.assignmentRequests = (await api.get('/automation/obligations')).data || [];
          closeSharedModal({ force: true });
          await loadTasks(container);
          window.yuvomi.showToast(button.dataset.requestAction === 'accept' ? 'Assignment accepted.' : 'Assignment declined.', 'success');
        } catch (err) {
          window.yuvomi.showToast(err.data?.error || err.message, 'danger');
          button.disabled = false;
        }
      }));
      if (window.lucide) window.lucide.createIcons({ el: panel });
    }});
  });
}

function updateBulkActionsBar(container) {
  const bar = container.querySelector('#bulk-actions-bar');
  const count = container.querySelector('#bulk-count');
  if (!bar) return;

  const selected = state.selectedTaskIds.size;
  const buttons = bar.querySelectorAll('button[id^="bulk-"]');

  bar.hidden = !(state.bulkSelectMode && selected > 0);
  bar.classList.toggle('bulk-actions-bar--active', selected > 0);
  buttons.forEach((button) => {
    button.disabled = selected === 0;
  });

  if (count) {
    count.textContent = t('tasks.bulkSelectedCount', { count: selected });
  }
}

function wireBulkSelect(container) {
  const toggleBtn = container.querySelector('#btn-bulk-select');
  if (!toggleBtn) return;

  toggleBtn.addEventListener('click', () => {
    state.bulkSelectMode = !state.bulkSelectMode;
    if (!state.bulkSelectMode) {
      state.selectedTaskIds.clear();
    }
    toggleBtn.classList.toggle('btn--active', state.bulkSelectMode);
    toggleBtn.setAttribute('aria-pressed', String(state.bulkSelectMode));
    loadTasks(container);
  });
}

function wireBulkCheckboxes(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  listEl.addEventListener('change', (e) => {
    const checkbox = e.target.closest('.task-bulk-checkbox');
    if (!checkbox) return;

    const taskId = Number(checkbox.dataset.taskId);
    if (checkbox.checked) {
      state.selectedTaskIds.add(taskId);
    } else {
      state.selectedTaskIds.delete(taskId);
    }
    updateBulkActionsBar(container);
  });
}

function wireBulkActions(container) {
  const bar = container.querySelector('#bulk-actions-bar');
  if (!bar) return;

  bar.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[id^="bulk-"]');
    if (!btn) return;

    const taskIds = [...state.selectedTaskIds];
    if (taskIds.length === 0) return;

    const action = btn.id;

    // Löschen läuft über dasselbe Optimistic-Undo-Muster wie der Einzel-Delete
    // (kein ungestylter window.confirm, immer rückgängig machbar — Critique P1).
    if (action === 'bulk-delete') {
      handleBulkDelete(taskIds, container);
      return;
    }

    if (action === 'bulk-tag-add' || action === 'bulk-tag-remove') {
      openBulkTagDialog(taskIds, action === 'bulk-tag-add' ? 'add' : 'remove', container);
      return;
    }

    try {
      if (action === 'bulk-mark-done' || action === 'bulk-mark-open') {
        const status = btn.dataset.status;
        await Promise.all(taskIds.map(id => api.patch(`/tasks/${id}/status`, { status })));
        window.yuvomi.showToast(t('tasks.bulkStatusChanged'), 'success');
      } else if (action === 'bulk-archive') {
        await Promise.all(taskIds.map(id => setTaskArchived(id, true)));
        window.yuvomi.showToast(t('tasks.bulkArchived'), 'success');
      }

      state.selectedTaskIds.clear();
      updateBulkActionsBar(container);
      await loadTasks(container);
    } catch (err) {
      window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
    }
  });
}

// Bulk-Delete mit Optimistic-Update + Undo-Toast — spiegelt handleDeleteTask
// für mehrere Aufgaben: Karten sofort ausblenden, 5s Undo-Fenster, dann erst
// die API-Aufrufe. Ersetzt den nativen window.confirm-Dialog (Critique P1).
function handleBulkDelete(taskIds, container) {
  const els = taskIds
    .map(id => container.querySelector(`[data-task-id="${id}"]`))
    .filter(Boolean);
  const prevDisplay = new Map();
  els.forEach(el => { prevDisplay.set(el, el.style.display); el.style.display = 'none'; });

  state.selectedTaskIds.clear();
  updateBulkActionsBar(container);

  const restore = () => els.forEach(el => { el.style.display = prevDisplay.get(el) ?? ''; });

  scheduleUndoableDelete({
    message: t('tasks.bulkDeleted'),
    commit: async ({ keepalive }) => {
      await Promise.all(taskIds.map(id => api.delete(`/tasks/${id}`, { keepalive })));
      taskIds.forEach(id => api.delete(`/reminders?entity_type=task&entity_id=${id}`, { keepalive }).catch(() => {}));
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      refreshReminders();
      await loadTasks(container);
    },
    restore: (err) => {
      restore();
      if (err) window.yuvomi.showToast(err.message ?? t('common.unknownError'), 'danger');
    },
  });
}

function openParticipantProfile(container, userId, anchor) {
  const panel = container.querySelector('#task-profile-popover');
  const user = state.users.find((entry) => Number(entry.id) === Number(userId));
  if (!panel || !user || !anchor) return;

  const participant = normalizeParticipant(user);
  const rows = [
    user.phone ? `<a class="task-profile-popover__contact" href="tel:${esc(user.phone)}">
      <i data-lucide="phone" class="icon-sm" aria-hidden="true"></i>
      <span><small>${esc(t('contacts.phoneLabel'))}</small>${esc(user.phone)}</span>
    </a>` : '',
    user.email ? `<a class="task-profile-popover__contact" href="mailto:${esc(user.email)}">
      <i data-lucide="mail" class="icon-sm" aria-hidden="true"></i>
      <span><small>${esc(t('contacts.emailLabel'))}</small>${esc(user.email)}</span>
    </a>` : '',
  ].filter(Boolean).join('');

  panel.setAttribute('aria-label', user.display_name);
  panel.replaceChildren();
  panel.insertAdjacentHTML('beforeend', `<div class="task-profile-popover__identity">
      ${renderAvatarStack([participant], { size: 52, maxVisible: 1 })}
      <span class="task-profile-popover__name">${esc(user.display_name)}</span>
      ${user.family_role ? `<span class="task-profile-popover__role">${esc(user.family_role)}</span>` : ''}
    </div>
    ${rows ? `<div class="task-profile-popover__contacts">${rows}</div>` : ''}`);
  window.lucide?.createIcons({ el: panel });
  openTaskControlPopover(container, panel, anchor);
  requestAnimationFrame(() => {
    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const contentRect = container.closest('.app-content')?.getBoundingClientRect();
    const gutter = 8;
    const minimum = Math.max(gutter, (contentRect?.left || 0) + gutter);
    const maximum = window.innerWidth - panelRect.width - gutter;
    const preferred = document.dir === 'rtl' ? anchorRect.right - panelRect.width : anchorRect.left;
    panel.style.left = `${Math.round(Math.max(minimum, Math.min(preferred, maximum)))}px`;
  });
}

function wireTaskList(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  listEl.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const id     = target.dataset.id;

    if (action === 'show-participant-profile') {
      openParticipantProfile(container, target.dataset.userId, target);
      return;
    }

    if (action === 'toggle-activity-details') {
      const taskId = Number(id);
      if (state.expandedTasks.has(taskId)) state.expandedTasks.delete(taskId);
      else state.expandedTasks.add(taskId);
      renderTaskList(container);
      return;
    }

    if (action === 'toggle-board-section') {
      const key = target.dataset.sectionKey;
      const collapsed = isBoardSectionCollapsed(key, target.dataset.sectionStatus);
      state.collapsedBoardSections.delete(key);
      state.expandedBoardSections.delete(key);
      if (collapsed) state.expandedBoardSections.add(key);
      else state.collapsedBoardSections.add(key);
      renderKanban(container);
      return;
    }

    if (action === 'open-bucket-sort') {
      openTaskSortPopover(container, target, target.dataset.bucketKey);
      return;
    }

    if (action === 'toggle-status') {
      const status = target.dataset.status;
      const nextStatus = status === 'done' ? 'open' : 'done';
      vibrate(15);
      // Beide Zustandsklassen führen, nicht nur die neue anhängen: der Knopf
      // trug sonst `--open` UND `--done` gleichzeitig (gemessen 2026-08-28),
      // und die Regel, die zuletzt im Stylesheet steht, gewann das Aussehen.
      target.classList.toggle('task-status-btn--done', nextStatus === 'done');
      target.classList.toggle('task-status-btn--open', nextStatus !== 'done');
      target.closest('.task-card')?.classList.toggle('task-card--done', nextStatus === 'done');
      // Die Quittung startet JETZT und läuft neben dem Roundtrip, nicht danach:
      // `loadTasks()` ersetzt den Knopf, und ohne dieses Warten war `check-pop`
      // (tasks.css:703) in 0 von 6 Messungen zu sehen. Siehe animationSettled().
      const settled = animationSettled(target);
      try {
        await toggleTaskStatus(id, status);
        await settled;
        await loadTasks(container);
        // Derselbe Rückweg wie beim Wischen. Die Geste hatte hier zwei
        // Endpunkte mit zwei Antworten: der Wisch bot Undo an, der Tipp - die
        // häufigere Bedienung - liess den Eintrag kommentarlos aus dem
        // gefilterten Bild verschwinden.
        //
        // Die Schlüssel heissen weiter `swiped*`: ihr TEXT ist gestenneutral
        // ("Als erledigt markiert."), nur der Name nennt die Wischgeste. Ein
        // Rename kostet 24 Locale-Dateien für eine Namensschuld, die kein
        // Nutzer sieht - vermerkt statt bezahlt.
        window.yuvomi.showToast(
          t(nextStatus === 'done' ? 'tasks.swipedDoneToast' : 'tasks.swipedOpenToast'),
          'default',
          5000,
          async () => {
            try {
              await toggleTaskStatus(id, nextStatus);
              await loadTasks(container);
            } catch (err) {
              window.yuvomi.showToast(err.message, 'danger');
            }
          },
        );
      } catch (err) {
        window.yuvomi.showToast(err.message, 'danger');
        await loadTasks(container);
      }
    }

    if (action === 'claim-activity') {
      target.disabled = true;
      try {
        await api.post(`/automation/tasks/${id}/claim`, {});
        window.yuvomi.showToast('Task claimed.', 'success');
        await loadTasks(container);
      } catch (err) {
        window.yuvomi.showToast(err.data?.error || err.message, 'danger');
        target.disabled = false;
      }
    }

    if (action === 'toggle-subtasks') {
      const taskId = Number(id);
      const open = isSubtasksExpanded(taskId);
      state.expandedSubtasks.delete(taskId);
      state.collapsedSubtasks.delete(taskId);
      if (open) state.collapsedSubtasks.add(taskId);
      else state.expandedSubtasks.add(taskId);
      renderTaskList(container);
      return;
    }

    if (action === 'toggle-subtask') {
      try {
        await toggleSubtaskStatus(id, target.dataset.status);
        await loadTasks(container);
      } catch (err) {
        window.yuvomi.showToast(err.message, 'danger');
      }
    }

    if (action === 'edit-task' || action === 'open-task') {
      try {
        const [task, reminder] = await Promise.all([
          loadTaskForEdit(id),
          loadReminderForTask(id),
        ]);
        openTaskView(task, reminder, container);
      } catch (err) {
        window.yuvomi.showToast(t('tasks.loadError'), 'danger');
      }
    }

    if (action === 'archive-task' || action === 'unarchive-task') {
      const archive = action === 'archive-task';
      try {
        await setTaskArchived(id, archive);
        window.yuvomi.showToast(archive ? t('tasks.archivedToast') : t('tasks.unarchivedToast'), 'success');
        await loadTasks(container);
      } catch (err) {
        window.yuvomi.showToast(err.message, 'danger');
      }
    }

    if (action === 'add-subtask') {
      await addSubtask(target.dataset.parent, { onChanged: () => loadTasks(container) });
    }

    if (action === 'rename-subtask') {
      await renameSubtask({ id, title: target.dataset.title }, {
        onChanged: () => loadTasks(container),
      });
    }

    if (action === 'delete-subtask') {
      await deleteSubtask({ id, title: target.dataset.title }, {
        onChanged: () => loadTasks(container),
      });
    }
  });

  listEl.addEventListener('keydown', (e) => {
    if (!['Enter', ' '].includes(e.key)) return;
    const target = e.target.closest('[data-action="open-task"]');
    if (!target || target !== e.target) return;
    e.preventDefault();
    target.click();
  });
}

// --------------------------------------------------------
// Haupt-Render
// --------------------------------------------------------

/**
 * Die geteilte Leseansicht mit dem Kontext DIESER Seite.
 *
 * Das Bearbeiten-Formular wird hier eingehaengt und nicht in der Komponente:
 * es gehoert dem Aufgabenmodul. Die Ansicht selbst kommt ohne aus (#918) - wer
 * sie ohne Mounter oeffnet, bekommt eine ohne Bearbeiten-Knopf statt einen,
 * der ins Leere fuehrt.
 */
function openTaskView(task, reminder, container, onChanged = () => loadTasks(container)) {
  openTaskDetail({
    task,
    reminder,
    users: state.users,
    currentUserId: state.currentUserId,
    isAdmin: state.isAdmin,
    categories: state.categories,
    container,
    onChanged,
    edit: {
      mount: (panel, pane) => {
        // Working-Set VOR dem Rendern setzen: renderTagChips in wireTaskForm
        // liest ihn direkt danach.
        modalTags = normalizeTagList(task.tags);
        pane.insertAdjacentHTML('beforeend', renderModalContent({ task, users: state.users, reminder }));
        wireTaskForm(panel, { task, container, onChanged });
      },
    },
  });
}

/**
 * Das Blatt dieses Moduls sicherstellen, wenn es von aussen geoeffnet wird.
 *
 * DER ROUTER HAELT GENAU EIN SEITEN-BLATT (loadPageStyle in router.js). Auf der
 * Uebersicht ist das dashboard.css, im Kalender calendar.css - tasks.css ist
 * dort nicht geladen. Die Leseansicht einer Aufgabe UND das Bearbeiten-Formular
 * holen ihr Aussehen aber von dort: Kommentare, Dokument-Chips,
 * Bildvorschauen, Etiketten, Prioritaets-Abzeichen, der Serienverlauf, und im
 * Formular die Tag-Zeile und die Feldhinweise. Ohne dieses Blatt erscheint das
 * alles fast ungestaltet - gemessen kam ein Etikett mit `border-radius: 0`
 * heraus und die Autorenzeile eines Kommentars mit Gewicht 400.
 *
 * EIN Blatt statt zweier Haelften, und das ist die eigentliche Entscheidung:
 * Die Regeln zwischen einem geteilten und einem Seiten-Blatt aufzuteilen hiesse,
 * bei jeder neuen Regel richtig einzusortieren - eine Sortierarbeit, die still
 * schiefgeht und zweimal schiefgegangen ist (`.priority-badge` blieb zurueck,
 * die Formularregeln alle). Wer das Modul von aussen oeffnet, bekommt sein
 * Blatt; das ist eine Regel statt einer Liste.
 *
 * GEWARTET WIRD DARAUF, sonst zeigt die Ansicht ihren Inhalt einmal roh.
 * Dasselbe Muster wie `loadReminderStyles` im Router, nur mit dem `onload`
 * davor. Der Fehlerfall loest ebenfalls auf: ein fehlendes Blatt ist ein
 * Schoenheitsfehler, kein Grund, die Aufgabe nicht zu zeigen.
 */
function ensureTaskStyles() {
  const href = '/styles/tasks.css';
  // Auch das Seiten-Blatt des Routers zaehlt: steht man auf /tasks, ist es da.
  if ([...document.styleSheets].some((sheet) => (sheet.href ?? '').endsWith(href))) return Promise.resolve();
  const vorhanden = document.querySelector(`link[data-task-styles][href="${href}"]`);
  if (vorhanden) return vorhanden.dataset.ready === '1'
    ? Promise.resolve()
    : new Promise((resolve) => vorhanden.addEventListener('load', resolve, { once: true }));

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.taskStyles = '';
  const ready = new Promise((resolve) => {
    link.onload = () => { link.dataset.ready = '1'; resolve(); };
    link.onerror = () => { link.dataset.ready = '1'; resolve(); };
  });
  document.head.appendChild(link);
  return ready;
}

/**
 * Eine Aufgabe oeffnen, ohne auf dieser Seite zu stehen (#918).
 *
 * Der Einstieg fuer die Uebersicht, die vier Kalenderansichten, das
 * Dringend-Widget und das Cockpit. Sie zeigen alle dieselbe Aufgabe an und
 * hatten bis dahin nur zwei Moeglichkeiten: ein eigenes, kleineres Kaertchen
 * bauen oder den Nutzer hierher schicken. Beide waren im Einsatz.
 *
 * Geladen wird hier, nicht beim Aufrufer: was eine Aufgabe zum Anzeigen
 * braucht - die vollstaendige Zeile, ihre Erinnerung, die Mitglieder und die
 * Kategorien des Haushalts - weiss dieses Modul, und ein Widget, das sich das
 * selbst zusammensucht, waere die naechste Fassung, die auseinanderlaeuft.
 *
 * `state` wird dabei nur gefuellt, soweit die Ansicht es liest; die Liste
 * dieser Seite bleibt unberuehrt, weil sie in diesem Fall gar nicht steht.
 *
 * @param {number|string} taskId
 * @param {{user?: object|null, container?: HTMLElement|null,
 *          onChanged?: () => (void|Promise<void>)}} opts
 *        `user` ist der angemeldete Mensch, so wie der Router ihn der
 *        aufrufenden Seite gibt. Er steht im Aufruf und wird NICHT aus einem
 *        Global geraten: an ihm haengt, wem seine eigenen Kommentare gehoeren
 *        und wer eine gesperrte Aufgabe umschreiben darf (#830). Fehlt er,
 *        bietet die Ansicht weniger an, als erlaubt waere - still und falsch.
 *        `container` ist die Umgebung, aus der geoeffnet wurde - sie liefert
 *        die Zeile fuers optimistische Ausblenden beim Loeschen. `onChanged`
 *        frischt genau diese Umgebung auf.
 */
export async function openTaskById(taskId, { user = null, container = null, onChanged = () => {} } = {}) {
  const [task, reminder] = await Promise.all([
    loadTaskForEdit(taskId),
    loadReminderForTask(taskId),
    ensureTaskStyles(),
  ]);
  if (!task) throw new Error(t('tasks.loadError'));

  // Mitglieder, Kategorien und Tags einmal holen, wenn diese Seite noch nie
  // stand. Ohne sie blieben @-Erwaehnungen unaufgeloest, die Kategoriezeile
  // zeigte ihren internen Schluessel und das Bearbeiten-Formular haette keine
  // Auswahl anzubieten.
  //
  // `meta` kommt OHNE `data`-Huelle: /tasks/meta/options antwortet mit den
  // Feldern direkt (server/routes/tasks.js), anders als die uebrigen Routen
  // dieses Moduls. Ein `meta.data?.users` daneben laese still `undefined`.
  if (!state.users.length || !state.categories.length) {
    try {
      const meta = await api.get('/tasks/meta/options');
      state.users         = meta.users      ?? state.users;
      state.categories    = meta.categories ?? state.categories;
      state.allTags       = meta.tags       ?? state.allTags;
      state.defaultPoints = Number(meta.default_points) || state.defaultPoints;
    } catch { /* Ansicht steht auch ohne - nur weniger aufgeloest, siehe unten. */ }
  }

  // The shared view can mount the complete fork Task form from Calendar or
  // Dashboard too. Hydrate the fork-only catalogues that form depends on;
  // otherwise Activity binding and Place search silently collapse to empty
  // controls outside /tasks even though the same Task supports them here.
  const [activityData, placesData, placeStatusData, preferencesData] = await Promise.all([
    api.get('/automation/activity-options').catch(() => ({ data: { activities: [] } })),
    api.get('/planning/places?active=false').catch(() => ({ data: [] })),
    api.get('/planning/place-search/status').catch(() => ({ data: { configured: false } })),
    api.get('/preferences').catch(() => ({ data: {} })),
  ]);
  state.activityTemplates = activityData.data?.activities ?? state.activityTemplates;
  state.places = placesData.data ?? state.places;
  state.placeSearchStatus = placeStatusData.data ?? state.placeSearchStatus ?? { configured: false };
  state.subtasksExpandedByDefault = preferencesData.data?.tasks_subtasks_expanded === true;
  state.defaultSyncTarget = preferencesData.data?.tasks_default_target || state.defaultSyncTarget;
  state.calendarWeekStart = weekStartIndex(preferencesData.data?.week_start);

  if (user) {
    state.currentUserId = user.id ?? null;
    state.isAdmin       = user.role === 'admin';
  }

  // OHNE KATEGORIEN KEIN FORMULAR. Die Auswahl wird aus `state.categories`
  // gebaut; blieb der Aufruf oben ohne Antwort, stuende dort ein leeres
  // Auswahlfeld, und ein Speichern schickte eine leere Kategorie, die der
  // Server ablehnt - nachdem wartende Datei-Uploads bereits durch sind. Die
  // Leseansicht bleibt, der Bearbeiten-Knopf faellt weg: kein Knopf ist
  // ehrlicher als einer, der in einen Fehler laeuft (dieselbe Regel wie beim
  // fehlenden Mounter).
  const canOfferEdit = state.categories.length > 0;

  openTaskDetail({
    task,
    reminder,
    users: state.users,
    currentUserId: state.currentUserId,
    isAdmin: state.isAdmin,
    categories: state.categories,
    container,
    onChanged,
    edit: !canOfferEdit ? null : {
      mount: (panel, pane) => {
        modalTags = normalizeTagList(task.tags);
        pane.insertAdjacentHTML('beforeend', renderModalContent({ task, users: state.users, reminder }));
        // `container` reist MIT, obwohl es hier die Uebersicht ist und keine
        // Aufgabenliste haelt: sein zweiter Zweck ist das Ausblenden der Zeile
        // beim Loeschen. Ohne ihn haette derselbe Loeschbefehl zwei Verhalten -
        // ueber den Knopf der Leseansicht ginge die Zeile sofort, ueber den im
        // Formular bliebe sie den ganzen Rueckgaengig-Streifen lang stehen.
        // Nachgeladen wird trotzdem nichts Fremdes: `onChanged` ist gesetzt und
        // verdraengt den `loadTasks`-Default.
        wireTaskForm(panel, { task, container, onChanged });
      },
    },
  });
}

export async function render(container, { user }) {
  state.user = user ?? null;
  state.currentUserId = user?.id ?? null;
  loadCollapsedGroups();
  // Die Rolle entscheidet nur darüber, ob ein fremder Kommentar entfernt werden
  // darf (#734) - der Server prüft dieselbe Bedingung noch einmal.
  state.isAdmin = user?.role === 'admin';

  // „Mir zugewiesen" pro Gerät wiederherstellen (setzt assigned_to auf die eigene ID)
  try {
    if (state.currentUserId != null && localStorage.getItem(ASSIGNED_TO_ME_KEY) === '1') {
      if (!hasFilter('assigned_to', state.currentUserId)) {
        state.filters.assigned_to = [...state.filters.assigned_to, String(state.currentUserId)];
      }
    }
  } catch {}

  // View-Mode: URL-Parameter > localStorage > Default 'list'
  const urlView = new URLSearchParams(window.location.search).get('view');
  const savedView = localStorage.getItem('yuvomi-tasks-view');
  const KNOWN_VIEWS = ['list', 'kanban', 'calendar', 'history'];
  state.viewMode = KNOWN_VIEWS.includes(urlView) ? urlView
    : KNOWN_VIEWS.includes(savedView) ? savedView
    : 'list';
  loadTaskLayoutState();

  // showFuture aus localStorage wiederherstellen
  try { state.showFuture = localStorage.getItem(SHOW_FUTURE_KEY) === '1'; } catch {}

  const isKanban = state.viewMode === 'kanban';
  // Was nur die Aufgabenliste betrifft, blendet `syncViewChrome` gleich nach
  // dem Einhängen aus - hier steht bewusst keine zweite Fassung derselben
  // Bedingung. `isHistory` traegt nur den Anfangszustand des Umschalters.
  const isHistory = state.viewMode === 'history';

  // Initiales Skeleton (all values are from i18n keys or hardcoded constants, no user data)
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="tasks-page page-measure--narrow">
      <div class="page-toolbar page-toolbar--wrap tasks-toolbar">
        <h1 class="page-toolbar__title">${t('tasks.title')}</h1>
        ${renderPageSearch({
          id: 'tasks-search',
          label: t('tasks.searchPlaceholder'),
          placeholder: t('tasks.searchPlaceholder'),
          value: state.searchQuery,
          clearLabel: t('common.searchClear'),
          className: 'tasks-toolbar__search page-toolbar__center',
        })}
        <div class="page-toolbar__actions">
          <!-- ICON PLUS LABEL, wie beim Geschwister-Umschalter in der Filterreihe
               (#group-mode-toggle, ~60 Zeilen tiefer). tasks.css:143 sagt ueber
               den Label-Verlust ausdruecklich „Der Ansichts-Umschalter im Kopf
               bekommt sie mit; er ist dasselbe Bauteil" - nur trug er gar kein
               Label, das haette fallen koennen. Die Regel lief hier ins Leere,
               und uebrig blieben drei stumme Glyphen (Critique 2026-08-28, P1:
               ein Kanban-Rechteck und ein Verlaufs-Pfeil sind kein geteiltes
               Vokabular). Unter 640px faellt das Label ueber die vorhandene
               Regel weg, mobil bleibt also die Icon-Form - iOS-Kanon.
               Die drei EINZELNEN Knoepfe daneben behalten ihre reine Icon-Form:
               ihre Namen sind Verben („Kategorien verwalten"), und ein
               aria-label als sichtbaren Text weiterzureichen verbietet
               DESIGN.md. Damit trennt jetzt auch der Text, was vorher nur die
               Behaelterform andeutete: benannte Ansichten in der Gruppe,
               unbenannte Werkzeuge daneben. -->
          <button type="button" class="btn btn--ghost task-control-btn tasks-toolbar-control filter-toggle-btn" id="filter-toggle-btn"
                  aria-label="${t('tasks.filterBtn')}" aria-expanded="false" aria-controls="filter-panel">
            <i data-lucide="sliders-horizontal" class="icon-sm" aria-hidden="true"></i>
            <span class="tasks-toolbar-control__label">${t('tasks.filterBtn')}</span>
          </button>
          <button type="button" class="btn btn--ghost task-control-btn tasks-toolbar-control" id="task-sort-btn"
                  aria-label="${t('tasks.sheetSort')}" aria-expanded="false" aria-controls="task-sort-panel">
            <i data-lucide="arrow-up-down" class="icon-sm" aria-hidden="true"></i>
            <span class="tasks-toolbar-control__label">${t('tasks.sheetSort')}</span>
          </button>
          <button type="button" class="btn btn--ghost task-control-btn tasks-toolbar-control" id="group-mode-toggle"
                  data-mode="category" aria-label="${t('tasks.groupToggleLabel')}" aria-expanded="false" aria-controls="task-group-panel">
            <i data-lucide="group" class="icon-sm" aria-hidden="true"></i>
            <span class="tasks-toolbar-control__label">${t('tasks.groupToggleLabel')}</span>
          </button>
          <button type="button" class="btn btn--ghost task-control-btn tasks-toolbar-control" id="task-view-btn"
                  aria-label="${t('tasks.viewToggleLabel')}" aria-expanded="false" aria-controls="task-view-panel">
            <i data-lucide="layout-grid" class="icon-sm" aria-hidden="true"></i>
            <span class="tasks-toolbar-control__label">${t('tasks.viewToggleLabel')}</span>
          </button>
          <button class="btn btn--ghost btn--icon" id="btn-bulk-select"
                  title="${t('tasks.bulkSelect')}" aria-label="${t('tasks.bulkSelect')}" aria-pressed="false">
            <i data-lucide="list-checks" class="icon-lg" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon btn--ghost" id="btn-manage-categories"
                  aria-label="${t('tasks.manageCategories')}" title="${t('tasks.manageCategories')}">
            <i data-lucide="folder-tree" class="icon-lg" aria-hidden="true"></i>
          </button>
          <!-- Der Tag-Verwalter bekommt das Etiketten-Icon, die Kategorien den
               Ordnerbaum: die beiden Achsen sind bewusst getrennt, und dieselbe
               Bildsprache für beide hätte genau das wieder eingeebnet. -->
          <button class="btn btn--icon btn--ghost" id="btn-manage-tags"
                  aria-label="${t('tasks.manageTags')}" title="${t('tasks.manageTags')}">
            <i data-lucide="tags" class="icon-lg" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon btn--ghost" id="btn-assignment-requests"
                  aria-label="Assignment requests" title="Assignment requests">
            <i data-lucide="inbox" class="icon-lg" aria-hidden="true"></i>
          </button>
          <button class="btn btn--primary toolbar-new-btn" id="btn-new-task" style="gap:var(--space-1)"
                  aria-label="${t('tasks.newTask')}">
            <i data-lucide="plus" class="icon-lg" aria-hidden="true"></i> <span class="toolbar-new-btn__label">${t('newLabel.tasks')}</span>
          </button>
          <button class="btn btn--icon btn--ghost" id="btn-quick-add"
                  aria-label="Quick Add from a template" title="Quick Add from a template">
            <i data-lucide="zap" class="icon-lg" aria-hidden="true"></i>
          </button>
        </div>
      </div>

      <div class="tasks-body">
        <div class="filter-panel task-control-popover" id="filter-panel" popover="auto"></div>
        <div class="task-control-popover" id="task-sort-panel" popover="auto"></div>
        <div class="task-control-popover" id="task-group-panel" popover="auto"></div>
        <div class="task-control-popover" id="task-view-panel" popover="auto"></div>
        <div class="task-control-popover task-profile-popover" id="task-profile-popover" popover="auto" role="dialog"></div>
        <div class="bulk-actions-bar" id="bulk-actions-bar" hidden>
          <span class="bulk-actions-bar__count" id="bulk-count"></span>
          <div class="bulk-actions-bar__actions">
            <button class="btn btn--secondary btn--sm" id="bulk-mark-done" data-status="done">
              <i data-lucide="check" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkMarkDone')}
            </button>
            <button class="btn btn--secondary btn--sm" id="bulk-mark-open" data-status="open">
              <i data-lucide="rotate-ccw" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkMarkOpen')}
            </button>
            <button class="btn btn--secondary btn--sm" id="bulk-archive">
              <i data-lucide="archive" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkArchive')}
            </button>
            <button class="btn btn--secondary btn--sm" id="bulk-tag-add">
              <i data-lucide="tag" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkTagAdd')}
            </button>
            <button class="btn btn--secondary btn--sm" id="bulk-tag-remove">
              <!-- Nicht "tag-off": das Icon gibt es im gebuendelten Lucide nicht,
                   der Knopf stand deshalb leer da. "eraser" traegt das Wegnehmen
                   und laesst sich vom "tag" des Nachbarknopfs unterscheiden -
                   zweimal dasselbe Icon nebeneinander waere keine Wahl. -->
              <i data-lucide="eraser" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkTagRemove')}
            </button>
            <button class="btn btn--danger btn--sm" id="bulk-delete">
              <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkDelete')}
            </button>
          </div>
        </div>

        <div id="task-list">
          ${[1,2,3].map(() => `
            <div class="widget-skeleton" style="margin-bottom:var(--space-2)">
              <div class="skeleton skeleton-line skeleton-line--medium" style="height:18px;margin-bottom:var(--space-3)"></div>
              <div class="skeleton skeleton-line skeleton-line--full" style="height:14px;margin-bottom:var(--space-2)"></div>
              <div class="skeleton skeleton-line skeleton-line--short" style="height:12px"></div>
            </div>`).join('')}
        </div>
        <button class="page-fab" id="fab-new-task" aria-label="${t('tasks.newTask')}" data-dock-label="${t('newLabel.tasks')}">
          <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  `);

  if (window.lucide) window.lucide.createIcons({ el: container });

  // Daten laden (Filter-State aus vorheriger Session berücksichtigen)
  try {
    const [tasksData, metaData, preferencesData, activityData, assignmentData, placesData, placeStatusData] = await Promise.all([
      api.get(`/tasks${taskQuery()}`),
      api.get('/tasks/meta/options'),
      // Reine Anzeigepräferenz: ein Fehler hier darf die Aufgabenliste nicht
      // mit in den Ladefehler ziehen, deshalb eigener Fallback.
      api.get('/preferences').catch(() => ({ data: {} })),
      // Activity Templates augment assignment; a catalogue failure must not
      // make the ordinary task list look unavailable.
      api.get('/automation/activity-options').catch(() => ({ data: { activities: [] } })),
      api.get('/automation/obligations').catch(() => ({ data: [] })),
      api.get('/planning/places?active=false').catch(() => ({ data: [] })),
      api.get('/planning/place-search/status').catch(() => ({ data: { configured: false } })),
    ]);
    state.loadError = null;
    state.tasks = tasksData.data ?? [];
    state.users = metaData.users ?? [];
    state.categories = metaData.categories ?? [];
    state.allTags = metaData.tags ?? [];
    state.defaultPoints = Number(metaData.default_points) || 0;
    state.activityTemplates = activityData.data?.activities ?? [];
    state.assignmentRequests = assignmentData.data ?? [];
    state.places = placesData.data ?? [];
    state.placeSearchStatus = placeStatusData.data ?? { configured: false };
    state.subtasksExpandedByDefault = preferencesData.data?.tasks_subtasks_expanded === true;
    state.defaultSyncTarget = preferencesData.data?.tasks_default_target || '';
    state.calendarWeekStart = weekStartIndex(preferencesData.data?.week_start);
  } catch (err) {
    console.error('[Tasks] Ladefehler:', err.message);
    // Der Toast allein war die falsche Antwort: er verging, und darunter blieb
    // „Keine Aufgaben - alles erledigt?" mit „Aufgabe erstellen" stehen. Bei
    // einem Serverfehler behauptet das nicht nur Datenverlust, es behauptet
    // Erledigung - und bietet als einzigen Ausweg eine schreibende Handlung.
    // Dieselbe Verwechslung, die Einkauf und Essensplan 2026-07-30 hatten
    // (Critique P0); `renderTaskList` prueft das Feld jetzt VOR dem Leer-Zweig.
    state.loadError = err;
    state.tasks = [];
    state.users = [];
    state.categories = [];
    state.allTags = [];
    state.defaultPoints = 0;
    state.activityTemplates = [];
    state.assignmentRequests = [];
    state.places = [];
    state.placeSearchStatus = { configured: false };
    state.subtasksExpandedByDefault = false;
    state.defaultSyncTarget = '';
  }

  // UI verdrahten
  wireViewToggle(container);
  wireGroupToggle(container);
  wireNewTaskBtn(container);
  wireQuickAddBtn(container);
  wireAssignmentRequestsBtn(container);
  wireTaskList(container);
  wireBulkSelect(container);
  wireBulkCheckboxes(container);
  wireBulkActions(container);
  wireTagBadgeFilter(container);
  container.querySelector('#btn-manage-categories')
    ?.addEventListener('click', () => openTaskCategoryManager(container));
  container.querySelector('#btn-manage-tags')
    ?.addEventListener('click', () => openTagManager(container));
  renderFilters(container);
  // Im Verlauf holt renderTaskList den Bestand selbst nach - er steckt nicht in
  // `/tasks`, und sein Ladefehler ist ein eigener.
  renderTaskList(container);

  wirePageSearch(container, {
    id: 'tasks-search',
    onQuery: (value) => {
      state.searchQuery = value;
      renderTaskList(container);
    },
  });

  // Deep-Link: ?open=<id> öffnet die Detailansicht
  const openId = new URLSearchParams(window.location.search).get('open');
  if (openId) {
    try {
      const [task, reminder] = await Promise.all([
        loadTaskForEdit(openId),
        loadReminderForTask(openId),
      ]);
      openTaskView(task, reminder, container);
    } catch { /* Task existiert nicht oder kein Zugriff */ }
  }
}

// Testfläche: nur reine Funktionen, deren Vertrag außerhalb dieser Datei zählt.
export const __test = {
  groupBy,
  groupKey,
  formatDueDate,
  buildTaskMonthDays,
  normalizeTaskCalendarRange,
  taskCalendarDate,
  formatDayMonth,
  taskQuery,
  state,
};
