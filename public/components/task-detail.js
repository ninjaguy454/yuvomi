/**
 * Modul: Aufgaben-Leseansicht (geteilte Komponente)
 * Zweck: Eine Aufgabe ansehen und mit ihr arbeiten - Status weiterschalten,
 *        Teilaufgaben abhaken, Haken in der Beschreibung setzen, kommentieren,
 *        ablegen, löschen. Eine Fassung für jede Ansicht, die eine Aufgabe
 *        anzeigt.
 * Abhängigkeiten: components/detail-view.js (Präsentation), api.js,
 *                 utils/task-fields.js (was ein Feld bedeutet),
 *                 utils/day-label.js, tasks.css
 *
 * API:
 *   openTaskDetail({ task, reminder, users, currentUserId, isAdmin,
 *                    categories, container, onChanged, edit })
 *   deleteTaskWithUndo(id, { container, onChanged })
 *   addSubtask(parentId, { onChanged })
 *   renameSubtask(subtask, { onChanged })
 *   deleteSubtask(subtask, { onChanged })
 *
 * WARUM DIESE DATEI EXISTIERT (#918). Die Ansicht lag in `pages/tasks.js` und
 * war damit nur von dort zu öffnen. Jede andere Stelle, die eine Aufgabe zeigt -
 * die Übersicht, die vier Kalenderansichten, das Dringend-Widget, das Cockpit -
 * hatte zwei Möglichkeiten: ein eigenes, kleineres Kärtchen bauen oder den
 * Nutzer ins Aufgabenmodul schicken. Beide waren im Einsatz, und beide waren
 * falsch: Die Übersicht ist die Ansicht, in der die App im Alltag benutzt wird,
 * und dort bot eine Aufgabe genau zwei Knöpfe an, während dieselbe Aufgabe eine
 * Seite weiter Teilaufgaben, Kommentare, Dokumente und abhakbare Zeilen in der
 * Beschreibung hatte.
 *
 * Der Markup zu duplizieren hätte garantiert, dass die beiden bei der nächsten
 * Änderung wieder auseinanderlaufen. Deshalb steht die Ansicht hier und die
 * Umgebung sagt ihr, was sie nicht wissen kann.
 */

import { api } from '/api.js';
import { t, formatDate, formatTime } from '/i18n.js';
import { openDetailView, closeDetailView, visibilityRow, assignedRow } from '/components/detail-view.js';
import { closeModal, promptModal, confirmModal, btnLoading } from '/components/modal.js';
import { recurrenceRow } from '/rrule-ui.js';
import { scheduleUndoableDelete } from '/utils/ux.js';
import { renderMarkdownLight } from '/utils/html.js';
import { splitKeepingLineEndings } from '/utils/markdown-checklist.js';
import { splitMentions, applyMention } from '/utils/mentions.js';
import { refresh as refreshReminders } from '/reminders.js';
import { parseRemindAtAsUtc } from '/utils/reminder-offset.js';
import { canTask } from '/permissions.js';
import { actionableSubtasks, changeTaskStatus, taskRevision } from '/utils/task-state.js';
import { watchTaskChanges, latestTaskLoader } from '/utils/task-live.js';
import { zonedDateKey } from '/utils/timezone.js';
import { historyDayLabel } from '/utils/day-label.js';
import {
  FALLBACK_CATEGORY, PRIORITY_LABELS, STATUS_LABELS,
  isArchived, canEditTaskDefinition, catLabel, normalizeTagList,
  docMime, docHref, docIcon, formatDueDate,
  normalizeParticipant, taskParticipants, subtaskParticipants, completionCounts, taskLocationLabel,
} from '/utils/task-fields.js';

// --------------------------------------------------------
// Schreibwege, die die Ansicht selbst geht
// --------------------------------------------------------

export async function toggleSubtaskStatus(id, currentStatus, snapshot = null) {
  const task = snapshot || (await api.get(`/tasks/${id}`)).data;
  return changeTaskStatus(task, currentStatus === 'done' ? 'in_progress' : 'done');
}

/** Ablegen bzw. zurückholen (#688) - der Status bleibt dabei, wie er war. */
export async function setTaskArchived(id, archived, snapshot = null) {
  const task = snapshot || (await api.get(`/tasks/${id}`)).data;
  return api.patch(`/tasks/${id}/archive`, { archived, ...taskRevision(task) });
}

/**
 * Jede Darstellung DIESER Aufgabe in der übergebenen Umgebung.
 *
 * Zwei Gründe, warum das kein `querySelector` mit einem Selektor ist:
 *
 * 1. DIE ÜBERSICHT NENNT IHR OBJEKT ANDERS. Eine Cockpit-Zeile kann jedes Modul
 *    meinen und trägt deshalb `data-object-kind` + `data-object-id` statt
 *    `data-task-id`. Ein Selektor, der nur den zweiten Namen kennt, findet dort
 *    nichts - und der Rückgängig-Streifen sagte fünf Sekunden lang "gelöscht",
 *    während die Zeile stehen blieb und sich anklicken ließ.
 * 2. EINE AUFGABE KANN MEHRFACH DASTEHEN. Auf der Übersicht zugleich im Cockpit
 *    und im Dringend-Widget. `querySelector` nähme die erste und ließe die
 *    andere stehen.
 *
 * Nur die äußersten Treffer: die Aufgabenkarte trägt ihre Id, und die
 * Mehrfachauswahl-Box darin ein zweites Mal.
 */
function taskRowsIn(container, id) {
  if (!container) return [];
  const hits = [...container.querySelectorAll(
    `[data-task-id="${id}"], [data-object-kind="task"][data-object-id="${id}"]`,
  )];
  return hits.filter((el) => !hits.some((other) => other !== el && other.contains(el)));
}

/**
 * Eine Aufgabe löschen, mit Rückgängig-Streifen statt Rückfrage.
 *
 * `container` ist optional und dient allein dem optimistischen Ausblenden: Wer
 * die Zeile im DOM hat - die Liste, das Widget, der Kalendertag -, sieht sie
 * sofort gehen. Wer nicht, sieht sie mit `onChanged` verschwinden.
 */
export async function deleteTaskWithUndo(id, { container = null, onChanged = () => {}, task = null } = {}) {
  let snapshot;
  try { snapshot = structuredClone(task || (await api.get(`/tasks/${id}`)).data); }
  catch (error) { window.yuvomi?.showToast(error.message, 'danger'); return; }
  closeModal({ force: true });
  const rows = taskRowsIn(container, id);
  for (const el of rows) el.style.display = 'none';

  scheduleUndoableDelete({
    message: t('tasks.deletedToast'),
    commit: async ({ keepalive }) => {
      await api.delete(`/tasks/${id}`, { keepalive, body: JSON.stringify(taskRevision(snapshot)) });
      // Erinnerungen für diese Aufgabe ebenfalls entfernen
      api.delete(`/reminders?entity_type=task&entity_id=${id}`, { keepalive }).catch(() => {});
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      refreshReminders();
      await onChanged();
    },
    restore: (err) => {
      for (const el of rows) el.style.display = '';
      if (err) window.yuvomi.showToast(err.message ?? t('common.unknownError'), 'danger');
    },
  });
}

/**
 * Teilaufgabe anlegen - der eine Weg für Liste und Leseansicht.
 *
 * Gibt die angelegte Teilaufgabe zurück (oder null bei Abbruch und Fehler):
 * die Leseansicht hängt sie sich damit selbst an, statt sich zum Nachladen
 * schließen zu müssen (#925).
 */
export async function addSubtask(parentId, {
  onChanged = () => {}, title: suppliedTitle, skillIds, throwOnError = false,
} = {}) {
  const title = suppliedTitle === undefined
    ? await promptModal(t('tasks.subtaskPrompt'))
    : suppliedTitle;
  if (!title) return null;
  try {
    const res = await api.post('/tasks', { title, parent_task_id: parentId,
      ...(skillIds === undefined ? {} : { skill_ids: skillIds }) });
    // Wie beim Abhaken daneben: die Umgebung trägt den Fortschrittsbalken der
    // Elternkarte, aber sie muss nichts davon zeigen.
    await onChanged();
    return res.data ?? null;
  } catch (err) {
    if (throwOnError) throw err;
    window.yuvomi.showToast(err.message, 'danger');
    return null;
  }
}

/** Rename a first-class subtask through the canonical Task route. */
export async function renameSubtask(subtask, {
  onChanged = () => {}, title: suppliedTitle, skillIds, throwOnError = false,
} = {}) {
  const currentTitle = String(subtask?.title || '');
  const title = suppliedTitle === undefined
    ? await promptModal(t('tasks.subtaskRenamePrompt'), currentTitle)
    : suppliedTitle;
  const skillsChanged = skillIds !== undefined
    && JSON.stringify([...skillIds].sort((a, b) => a - b)) !== JSON.stringify([...(subtask.skill_ids || [])].sort((a, b) => a - b));
  if (!title || (title.trim() === currentTitle && !skillsChanged)) return null;
  try {
    const nextTitle = title.trim();
    const response = await api.put(`/tasks/${subtask.id}`, { title: nextTitle, ...taskRevision(subtask),
      ...(skillIds === undefined ? {} : { skill_ids: skillIds }) });
    subtask.title = nextTitle;
    if (skillIds !== undefined) {
      subtask.skill_ids = response.data?.skill_ids || [...skillIds];
      subtask.skills = response.data?.skills || (subtask.skills || []).filter((skill) => skillIds.includes(Number(skill.id)));
      subtask.skill_assignment_needed = response.data?.skill_assignment_needed
        ?? (subtask.skill_ids.length > 0 && subtask.assigned_to == null);
    }
    await onChanged();
    return nextTitle;
  } catch (err) {
    if (throwOnError) throw err;
    window.yuvomi.showToast(err.message, 'danger');
    return null;
  }
}

/** Delete a first-class subtask after explaining that the action is permanent. */
export async function deleteSubtask(subtask, { onChanged = () => {} } = {}) {
  const ok = await confirmModal(t('tasks.subtaskDeleteConfirm', { title: subtask?.title || '' }), {
    confirmLabel: t('common.delete'),
    danger: true,
    detail: t('tasks.subtaskDeleteDetail'),
  });
  if (!ok) return false;
  try {
    await api.delete(`/tasks/${subtask.id}`, { body: JSON.stringify(taskRevision(subtask)) });
    await onChanged();
    return true;
  } catch (err) {
    window.yuvomi.showToast(err.message, 'danger');
    return false;
  }
}

// --------------------------------------------------------
// Bausteine der Leseansicht
// --------------------------------------------------------

// Was aus dem aktuellen Status als Nächstes kommt. Abgelegte Aufgaben führen
// keine Weiterschaltung: sie sind aus dem Lauf genommen, nicht angehalten - ihr
// Knopf holt zurück (siehe openTaskDetail).


/** Prioritätsbadge als DOM - dieselbe Optik wie auf der Karte. */
function priorityNode(priority) {
  if (!priority || priority === 'none') return null;
  const badge = document.createElement('span');
  badge.className = 'priority-badge';
  const dot = document.createElement('span');
  dot.className = `priority-dot priority-dot--${priority}`;
  badge.append(dot, document.createTextNode(PRIORITY_LABELS()[priority] ?? priority));
  return badge;
}

/** Eine Chip-Reihe aus einer Liste. Beschriftung liefert der Aufrufer. */
function chipListNode(items, toLabel) {
  if (!items.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'detail-chips';
  items.forEach((item) => {
    const chip = document.createElement('span');
    chip.className = 'task-tag';
    chip.textContent = toLabel(item);
    wrap.appendChild(chip);
  });
  return wrap;
}

/** Tags als Chips. In der Leseansicht benennen sie, sie filtern nicht. */
function tagChipsNode(tags) {
  return chipListNode(normalizeTagList(tags), (tag) => tag);
}

function taskSkillSummary(task, ctx) {
  const names = new Map([...(ctx.skills || []), ...(task.skills || [])]
    .map((skill) => [Number(skill.id), skill.name]));
  const ids = task.skill_ids || (task.skills || []).map((skill) => skill.id);
  if (!ids.length) return '';
  const summary = ids.map((id) => names.get(Number(id)) || 'Unavailable skill').join(', ');
  return summary;
}

function lucideIcon(name) {
  const icon = document.createElement('i');
  icon.dataset.lucide = name;
  icon.className = 'icon-sm';
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

let activeParticipantPreview = null;

function closeParticipantPreview() {
  activeParticipantPreview?.remove();
  activeParticipantPreview = null;
}

function participantInitials(name = '') {
  return name.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function openParticipantPreview(person, anchor, ctx) {
  closeParticipantPreview();
  const known = (ctx.users || []).find((user) => Number(user.id) === Number(person.id));
  const profile = { ...person, ...(known || {}) };
  const panel = document.createElement('div');
  panel.className = 'task-detail-profile-preview';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', profile.display_name || t('tasks.participantsLabel'));

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn--ghost btn--icon btn--icon-sm task-detail-profile-preview__close';
  close.setAttribute('aria-label', t('common.close'));
  close.appendChild(lucideIcon('x'));
  close.addEventListener('click', closeParticipantPreview);

  const avatar = document.createElement(profile.avatar_data ? 'img' : 'span');
  avatar.className = 'task-detail-profile-preview__avatar';
  if (profile.avatar_data) {
    avatar.src = profile.avatar_data;
    avatar.alt = '';
  } else {
    avatar.textContent = participantInitials(profile.display_name);
    avatar.style.backgroundColor = profile.avatar_color || profile.color || '#64748b';
  }

  const identity = document.createElement('div');
  identity.className = 'task-detail-profile-preview__identity';
  const name = document.createElement('strong');
  name.textContent = profile.display_name || '';
  identity.append(avatar, name);
  if (profile.family_role) {
    const familyRole = document.createElement('span');
    familyRole.textContent = profile.family_role;
    identity.appendChild(familyRole);
  }

  const contacts = document.createElement('div');
  contacts.className = 'task-detail-profile-preview__contacts';
  for (const [kind, value, label] of [
    ['phone', profile.phone, t('contacts.phoneLabel')],
    ['mail', profile.email, t('contacts.emailLabel')],
  ]) {
    if (!value) continue;
    const link = document.createElement('a');
    link.href = kind === 'phone' ? `tel:${value}` : `mailto:${value}`;
    const icon = document.createElement('i');
    icon.dataset.lucide = kind;
    icon.className = 'icon-sm';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    const caption = document.createElement('small');
    caption.textContent = label;
    text.append(caption, document.createTextNode(String(value)));
    link.append(icon, text);
    contacts.appendChild(link);
  }

  panel.append(close, identity);
  if (contacts.childElementCount) panel.appendChild(contacts);
  document.body.appendChild(panel);
  activeParticipantPreview = panel;

  const rect = anchor.getBoundingClientRect();
  const width = panel.getBoundingClientRect().width;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(Math.min(rect.bottom + 8, window.innerHeight - panel.offsetHeight - 8))}px`;
  if (window.lucide) window.lucide.createIcons({ el: panel });

  const outside = (event) => {
    if (panel.contains(event.target) || anchor.contains(event.target)) return;
    closeParticipantPreview();
    document.removeEventListener('pointerdown', outside, true);
  };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeParticipantPreview();
    anchor.focus();
  });
}

function participantButton(person, role, ctx) {
  const normalized = normalizeParticipant(person, role);
  if (!normalized) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'task-detail-participant';
  button.setAttribute('aria-label', normalized.display_name);

  const avatar = document.createElement(normalized.avatar_data ? 'img' : 'span');
  avatar.className = 'task-detail-participant__avatar';
  if (normalized.avatar_data) {
    avatar.src = normalized.avatar_data;
    avatar.alt = '';
  } else {
    avatar.textContent = participantInitials(normalized.display_name);
    avatar.style.backgroundColor = normalized.color;
  }
  const text = document.createElement('span');
  text.className = 'task-detail-participant__text';
  const name = document.createElement('strong');
  name.textContent = normalized.display_name;
  text.appendChild(name);
  if (role) {
    const roleLabel = document.createElement('small');
    roleLabel.textContent = String(role).replaceAll('_', ' ');
    text.appendChild(roleLabel);
  }
  button.append(avatar, text);
  button.addEventListener('click', () => openParticipantPreview(normalized, button, ctx));
  return button;
}

function participantListNode(task, ctx) {
  const people = taskParticipants(task);
  if (!people.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'task-detail-participants';
  for (const person of people) {
    const button = participantButton(person, person.role, ctx);
    if (button) wrap.appendChild(button);
  }
  return wrap;
}

function responsibilityListNode(task, ctx) {
  const rows = task.activity_responsibilities || [];
  if (!rows.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'task-detail-responsibilities';
  for (const row of rows) {
    const button = participantButton(row, row.role, ctx);
    if (button) wrap.appendChild(button);
  }
  return wrap;
}

function progressNode(task) {
  if (!actionableSubtasks(task).length) return null;
  const progress = completionCounts(task);
  const wrap = document.createElement('div');
  wrap.className = 'task-detail-progress';
  const meter = document.createElement('progress');
  meter.max = progress.total;
  meter.value = progress.done;
  meter.setAttribute('aria-label', t('tasks.subtasksLabel'));
  const label = document.createElement('span');
  label.textContent = `${progress.done} of ${progress.total} complete · ${Math.round(progress.done / progress.total * 100)}%`;
  if (progress.totalPoints > 0) {
    label.append(document.createTextNode(` · ${t('tasks.progressPointsValue', progress)}`));
  }
  wrap.append(meter, label);
  return wrap;
}

function activityTemplateSummary(task) {
  if (!task.activity_template_name) return '';
  return task.activity_subject_name
    ? `${task.activity_template_name} · ${task.activity_subject_name}`
    : task.activity_template_name;
}

function assignmentSummary(task) {
  if (!task.activity_assignment_policy && !task.activity_assignment_state) return '';
  const labels = { fixed: 'Fixed household member', open_claimable: 'Available to claim', assigned: 'Assigned', open: 'Available to claim', unavailable: 'Assignment needs attention', fulfilled: 'Completed', supervised_completion: 'Supervised completion', round_robin: 'Rotating assignment' };
  const parts = [task.activity_assignment_policy, task.activity_assignment_state].filter(Boolean).map((value) => labels[value] || String(value).replaceAll('_', ' '));
  if (task.activity_assignment_override_allowed) parts.push(t('tasks.assignmentOverrideAllowed'));
  return parts.join(' · ');
}

function presenceSummary(task) {
  const policies = { ignore: '', available_before_due: 'An available opening before it is due', must_be_home: 'Expected to be at Home', must_be_at_location: 'Expected to be at the required place' };
  const windows = { at_due_time: 'At the due time', useful_completion_window: 'During the completion window', now: 'Now' };
  return [task.activity_place_name, policies[task.activity_presence_policy] || '', windows[task.activity_presence_window] || ''].filter(Boolean).join(' · ');
}

function taskLocationNode(task, ctx) {
  if (!task.location) return null;
  const location = task.location;
  const wrap = document.createElement('div');
  wrap.className = 'task-detail-location';
  const name = document.createElement('strong');
  name.textContent = taskLocationLabel(task) || t('tasks.taskLocationFallback');
  wrap.appendChild(name);
  if (location.address && location.address !== name.textContent) {
    const address = document.createElement('span');
    address.textContent = location.address;
    wrap.appendChild(address);
  }

  const actions = document.createElement('div');
  actions.className = 'detail-inline-actions';
  if (location.navigation_url) {
    const navigate = document.createElement('a');
    navigate.className = 'btn btn--secondary btn--sm';
    navigate.href = location.navigation_url;
    navigate.target = '_blank';
    navigate.rel = 'noopener noreferrer';
    const label = document.createElement('span');
    label.textContent = t('tasks.openInGoogleMaps');
    navigate.append(lucideIcon('navigation'), label);
    actions.appendChild(navigate);
  }
  if (ctx.isAdmin && location.kind === 'google_place') {
    const promote = document.createElement('button');
    promote.type = 'button';
    promote.className = 'btn btn--secondary btn--sm';
    promote.textContent = t('tasks.saveToYuvomiPlaces');
    promote.addEventListener('click', async () => {
      promote.disabled = true;
      try {
        await api.post(`/tasks/${task.id}/location/promote`, { name: location.label, type: 'custom' });
        window.yuvomi.showToast(t('tasks.locationSavedToYuvomiPlaces'), 'success');
        await closeDetailView({ force: true });
        await ctx.onChanged();
      } catch (err) {
        promote.disabled = false;
        window.yuvomi.showToast(err.message, 'danger');
      }
    });
    actions.appendChild(promote);
  }
  const scope = document.createElement('span');
  scope.className = 'form-hint';
  scope.textContent = location.kind === 'saved_place'
    ? t('tasks.savedPlaceLabel')
    : t('tasks.oneUseLocationLabel');
  actions.appendChild(scope);
  wrap.appendChild(actions);
  if (window.lucide) window.lucide.createIcons({ el: wrap });
  return wrap;
}

/** Teilaufgaben mit ihrem Stand - die Liste führt sie, also führt die Ansicht sie auch. */
/**
 * Teilaufgaben in der Detailansicht - abhakbar, nicht nur lesbar (#671).
 *
 * Bis v1.78.0 waren die Zeilen hier reine Anzeige, während dieselbe Teilaufgabe
 * in der Listenkarte einen Schalter hatte. Wer eine Teilaufgabe anlegte und
 * danach die Aufgabe öffnete, sah sie also, kam aber nicht mehr an sie heran -
 * genau die Beobachtung aus der Meldung.
 *
 * Der Klick-Handler des Seiten-Containers greift hier nicht: Die Detailansicht
 * rendert in den Top-Layer, außerhalb von `container`. Deshalb hängt die
 * Delegation am Wrapper selbst.
 *
 * Der Abschnitt bleibt auch leer stehen, solange er etwas anzubieten hat -
 * dieselbe Regel wie bei der Unterhaltung ganz unten, und hier aus einem
 * gemessenen Grund: die Karte blendet ihre Inline-Aktionen unter 640px aus
 * (tasks.css, HIG-Dichte), und der erste Teilschritt hängt genau an dem Knopf,
 * den sie dabei mitnimmt. Der gedachte Ersatzweg war diese Ansicht - nur bot
 * sie den Einstieg nie an, weil sie ohne Teilaufgaben gar nicht erst erschien.
 * Auf dem iPhone gab es damit keinen Weg zur ERSTEN Teilaufgabe, während jede
 * weitere über die aufgeklappte Liste ging (#925).
 */
function subtaskListNode(task, ctx) {
  const children = actionableSubtasks(task);
  // Definitions and required skills are edited only in Edit.
  if (!children.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'detail-subtasks detail-task-subtasks';
  for (const subtask of children) {
    const row = document.createElement('div');
    row.className = 'detail-subtask';
    row.dataset.subtaskId = String(subtask.id);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    const done = subtask.status === 'done';
    toggle.className = `detail-subtask__toggle${done ? ' detail-subtask__toggle--done' : ''}`;
    toggle.dataset.taskOperation = '';
    toggle.dataset.focusKey = `subtask-${subtask.id}`;
    toggle.setAttribute('aria-pressed', String(done));
    toggle.setAttribute('aria-label', `${done ? 'Reopen' : 'Complete'}: ${subtask.title}`);
    const label = document.createElement('span');
    label.className = 'detail-subtask__title';
    label.textContent = subtask.title;
    toggle.append(lucideIcon(done ? 'check-circle-2' : 'circle'), label);
    const supervision = subtask.supervision_action || task.supervision?.actions?.find((action) => Number(action.action_task_id) === Number(subtask.id));
    toggle.disabled = isArchived(task) || !canTask(subtask, 'complete') || (supervision && (typeof supervision.can_complete === 'boolean' ? !supervision.can_complete : supervision.state !== 'not_required' && (supervision.state !== 'assigned' || Number(supervision.supervisor_user_id) !== Number(ctx.currentUserId))));
    const meta = document.createElement('div');
    meta.className = 'detail-subtask__meta';
    const skills = taskSkillSummary(subtask, ctx);
    const parts = [skills];
    if (supervision && supervision.state !== 'not_required') {
      parts.push(supervision.state === 'assigned' ? 'Supervision required' : 'Supervision needed');
      if (supervision.supervisor_name) parts.push(`Supervisor: ${supervision.supervisor_name}`);
    }
    const points = Number(subtask.points || 0);
    if (points) parts.push(t('tasks.pointsSummary', { count: points }));
    meta.textContent = parts.filter(Boolean).join(' · ');
    meta.hidden = !meta.textContent;
    row.append(toggle, meta);
    toggle.addEventListener('click', async () => {
      if (ctx.busy) return;
      await ctx.runMutation(toggle, () => changeTaskStatus(subtask, done ? 'in_progress' : 'done'));
    });
    wrap.appendChild(row);
  }
  return wrap;
}

/**
 * Verknüpfte Dokumente in der Leseansicht (#733).
 *
 * Zwei Korrekturen an einer Stelle: Die alte Fassung las `doc.title` und
 * `doc.filename` - beides Felder, die ein Dokument nie hatte (es heißt `name`
 * bzw. `original_name`), und sie bekam ohnehin nie eine Liste, weil die API das
 * Feld gar nicht füllte. Die Zeile war also doppelt leer.
 *
 * Bilder stehen als Vorschau statt als Wort: an einer Aufgabe hängt meist ein
 * abfotografierter Zettel, und ein Dateiname beantwortet die Frage nicht, wegen
 * der man das Foto angehängt hat. Alles andere bleibt ein Chip mit Link.
 */
function documentListNode(docs) {
  const list = Array.isArray(docs) ? docs : [];
  if (!list.length) return null;

  const images = list.filter((doc) => docMime(doc).startsWith('image/'));
  const rest = list.filter((doc) => !docMime(doc).startsWith('image/'));

  const wrap = document.createElement('div');
  wrap.className = 'task-detail__docs';

  if (images.length) {
    const grid = document.createElement('div');
    grid.className = 'task-detail__doc-previews';
    for (const doc of images) {
      const link = document.createElement('a');
      link.className = 'task-detail__doc-preview';
      link.href = docHref(doc);
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = doc.name || '';
      const img = document.createElement('img');
      img.src = `/api/v1/documents/${doc.id}/preview`;
      img.alt = doc.name || '';
      img.loading = 'lazy';
      link.appendChild(img);
      grid.appendChild(link);
    }
    wrap.appendChild(grid);
  }

  for (const doc of rest) {
    const chip = document.createElement('a');
    chip.className = 'task-doc-chip';
    chip.href = docHref(doc);
    chip.target = '_blank';
    chip.rel = 'noopener';
    const icon = document.createElement('i');
    icon.dataset.lucide = docIcon(doc);
    icon.className = 'task-doc-chip__icon icon-sm';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'task-doc-chip__name';
    label.textContent = doc.name || doc.original_name || String(doc.id);
    chip.append(icon, label);
    wrap.appendChild(chip);
  }

  if (window.lucide) window.lucide.createIcons({ el: wrap });
  return wrap;
}

// --------------------------------------------------------
// Kommentare an einer Aufgabe (#734)
//
// „Damit die Absprache dort steht, wo die Sache steht." Der Abschnitt lädt
// selbst nach: die Detailansicht öffnet sofort, die Unterhaltung kommt in dem
// Moment dazu, in dem sie da ist - das ist billiger als ein Ladebalken vor der
// ganzen Ansicht.
// --------------------------------------------------------

/** Kommentartext als DOM, Erwähnungen hervorgehoben. Kein innerHTML nötig. */
function commentTextNode(text, ctx) {
  const box = document.createElement('div');
  box.className = 'task-comment__text';
  for (const segment of splitMentions(text, ctx.users)) {
    if (segment.type !== 'mention') {
      box.appendChild(document.createTextNode(segment.text));
      continue;
    }
    const chip = document.createElement('span');
    // Die eigene Erwähnung sticht heraus: „mich hat jemand gemeint" ist die
    // Information, wegen der man den Kommentar überhaupt liest.
    chip.className = segment.user.id === ctx.currentUserId
      ? 'task-comment__mention task-comment__mention--me'
      : 'task-comment__mention';
    chip.textContent = segment.text;
    box.appendChild(chip);
  }
  return box;
}

/** Eine Zeile der Unterhaltung. */
function commentRowNode(comment, { onChanged, ctx }) {
  const row = document.createElement('article');
  row.className = 'task-comment';

  const head = document.createElement('div');
  head.className = 'task-comment__head';

  const author = document.createElement('span');
  author.className = 'task-comment__author';
  author.textContent = comment.author_name || t('tasks.commentUnknownAuthor');

  const when = document.createElement('span');
  when.className = 'task-comment__when';
  const at = new Date(comment.updated_at || comment.created_at);
  when.textContent = comment.updated_at
    ? t('tasks.commentEditedAt', { date: formatDate(at), time: formatTime(at) })
    : `${formatDate(at)} ${formatTime(at)}`;

  head.append(author, when);

  const mine = comment.user_id === ctx.currentUserId;
  if ((mine || ctx.isAdmin) && canTask(ctx.task, 'comment')) {
    const actions = document.createElement('div');
    actions.className = 'task-comment__actions';

    // Ändern darf nur der Autor - ein Admin moderiert, er schreibt nicht um.
    if (mine) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'task-comment__action';
      edit.setAttribute('aria-label', t('tasks.commentEdit'));
      edit.title = t('tasks.commentEdit');
      const editIcon = document.createElement('i');
      editIcon.dataset.lucide = 'pencil';
      editIcon.className = 'icon-sm';
      editIcon.setAttribute('aria-hidden', 'true');
      edit.appendChild(editIcon);
      edit.addEventListener('click', () => startCommentEdit(row, comment, { onChanged, ctx }));
      actions.appendChild(edit);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-comment__action task-comment__action--danger';
    del.setAttribute('aria-label', t('tasks.commentDelete'));
    del.title = t('tasks.commentDelete');
    const delIcon = document.createElement('i');
    delIcon.dataset.lucide = 'trash-2';
    delIcon.className = 'icon-sm';
    delIcon.setAttribute('aria-hidden', 'true');
    del.appendChild(delIcon);
    // Kein Bestätigungsdialog, sondern der Rückgängig-Toast, den diese Seite
    // schon fürs Löschen einer Aufgabe benutzt. Zwei Gründe: Eine Rückfrage
    // wäre hier ein Modal über einem Modal - `confirmModal` verdrängt die
    // Detailansicht, `confirmOverModal` schließt sie beim Bestätigen (beides
    // gemessen, man stand danach wieder in der Liste). Und ein Kommentar ist
    // kein Datensatz mit Anhängseln: Zurücknehmen ist die ehrlichere Antwort
    // als Vorher-Fragen.
    del.addEventListener('click', () => {
      row.hidden = true;
      scheduleUndoableDelete({
        message: t('tasks.commentDeletedToast'),
        commit: async ({ keepalive }) => {
          await api.delete(`/tasks/${comment.task_id}/comments/${comment.id}`, { keepalive });
          if (keepalive) return; // Seite verschwindet - kein Nachladen mehr
          await onChanged();
        },
        restore: (err) => {
          row.hidden = false;
          if (err) window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
        },
      });
    });
    actions.appendChild(del);
    head.appendChild(actions);
  }

  row.append(head, commentTextNode(comment.comment, ctx));
  return row;
}

/** Eine Zeile gegen ein Eingabefeld tauschen, ohne die Liste neu zu laden. */
function startCommentEdit(row, comment, { onChanged, ctx }) {
  const form = document.createElement('form');
  form.className = 'task-comment__edit';

  const field = document.createElement('textarea');
  field.className = 'input task-comment__input';
  field.rows = 3;
  field.maxLength = 5000;
  field.value = comment.comment;

  const actions = document.createElement('div');
  actions.className = 'task-comment__edit-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn--ghost btn--sm';
  cancel.textContent = t('common.cancel');
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn--primary btn--sm';
  save.textContent = t('common.save');
  actions.append(cancel, save);

  cancel.addEventListener('click', () => {
    // Die zurueckgeholte Zeile bringt ihre Icons als `data-lucide` mit, nicht
    // als fertiges SVG - ohne diesen Aufruf stuenden Bearbeiten und Loeschen
    // als leere Kaesten da, und zwar bis zum naechsten Nachladen.
    const restored = commentRowNode(comment, { onChanged, ctx });
    row.replaceWith(restored);
    if (window.lucide) window.lucide.createIcons({ el: restored });
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = field.value.trim();
    if (!value) return;
    save.disabled = true;
    try {
      await api.patch(`/tasks/${comment.task_id}/comments/${comment.id}`, { comment: value });
      await onChanged();
    } catch (err) {
      save.disabled = false;
      window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
    }
  });

  form.append(field, actions);
  row.replaceChildren(form);
  wireMentionSuggest(field, ctx);
  field.focus();
}

/**
 * Vorschläge beim Tippen eines @.
 *
 * Komfort, keine Bedingung: wer den Namen ausschreibt, wird genauso erwähnt -
 * gelesen wird am Ende der Text, nicht die Auswahl (utils/mentions.js).
 */
function wireMentionSuggest(field, ctx) {
  let box = null;
  let matches = [];
  let active = 0;

  const close = () => { box?.remove(); box = null; matches = []; };

  /** Das angefangene @-Wort links vom Cursor, oder null. */
  const currentQuery = () => {
    const upto = field.value.slice(0, field.selectionStart);
    const at = upto.lastIndexOf('@');
    if (at === -1) return null;
    if (at > 0 && /[\p{L}\p{N}_]/u.test(upto[at - 1])) return null;
    const typed = upto.slice(at + 1);
    // Ein Zeilenumbruch beendet die Suche; ein Leerzeichen darf drin bleiben,
    // weil Anzeigenamen zwei Wörter haben können.
    if (/[\n\r]/.test(typed) || typed.length > 40) return null;
    return { at, typed };
  };

  const apply = (user) => {
    // Die Frage wird hier NOCH EINMAL gestellt, statt sich auf den Stand vom
    // letzten Tastendruck zu verlassen: liegt der Cursor inzwischen woanders,
    // gibt es nichts zu ersetzen, und ein blindes Einfuegen zerschnitte den
    // Text an einer Stelle, die niemand gemeint hat.
    const next = applyMention(field.value, field.selectionStart, user.display_name);
    if (!next) { close(); return; }
    field.value = next.text;
    field.setSelectionRange(next.caret, next.caret);
    close();
    field.focus();
  };

  const render = () => {
    if (!box) {
      box = document.createElement('div');
      box.className = 'task-comment__suggest';
      box.setAttribute('role', 'listbox');
      field.parentElement.appendChild(box);
    }
    box.replaceChildren();
    matches.forEach((user, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = index === active
        ? 'task-comment__suggest-item is-active'
        : 'task-comment__suggest-item';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === active));
      option.textContent = user.display_name;
      // mousedown statt click: ein Klick käme erst nach dem blur, und das
      // schließt die Liste, bevor der Treffer übernommen wäre.
      option.addEventListener('mousedown', (e) => { e.preventDefault(); apply(user); });
      box.appendChild(option);
    });
  };

  /** Vorschlaege zur aktuellen Cursorposition neu bestimmen. */
  const sync = () => {
    const query = currentQuery();
    if (!query) { close(); return; }
    const needle = query.typed.toLowerCase();
    matches = ctx.users
      .filter((u) => u.display_name && u.display_name.toLowerCase().startsWith(needle))
      .slice(0, 6);
    active = 0;
    if (!matches.length) { close(); return; }
    render();
  };

  field.addEventListener('input', sync);

  // Der Cursor wandert auch ohne Eingabe - mit Pfeiltasten, per Klick, per
  // Auswahl. Ohne diese beiden Zeilen bliebe die Liste offen, waehrend sie sich
  // laengst auf ein anderes Wort bezieht: Enter fuegte den Namen dann an der
  // NEUEN Position ein (aus „@Ann" mit Cursor hinter dem zweiten Zeichen wurde
  // „@Anna nn"), und am Textanfang verschluckte sie stumm den Zeilenumbruch.
  field.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) sync();
  });
  field.addEventListener('click', sync);

  field.addEventListener('keydown', (e) => {
    if (!box || !matches.length) return;
    if (e.key === 'ArrowDown')      { e.preventDefault(); active = (active + 1) % matches.length; render(); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); active = (active - 1 + matches.length) % matches.length; render(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); apply(matches[active]); }
    else if (e.key === 'Escape')    { e.stopPropagation(); close(); }
  });

  field.addEventListener('blur', () => setTimeout(close, 0));
}

/** Der ganze Abschnitt: Liste, Eingabe, Nachladen. */
function commentsNode(task, ctx) {
  if (ctx.comments) return ctx.comments;
  const wrap = document.createElement('div');
  wrap.className = 'task-comments';
  ctx.comments = wrap;
  let requestSequence = 0;

  const list = document.createElement('div');
  list.className = 'task-comments__list';
  const status = document.createElement('p');
  status.className = 'task-comments__status';
  status.textContent = t('common.loading');
  list.appendChild(status);

  const load = async () => {
    if (list.querySelector('.task-comment__edit')) return;
    const request = ++requestSequence;
    try {
      const res = await api.get(`/tasks/${task.id}/comments`);
      if (request !== requestSequence || ctx.closed || list.querySelector('.task-comment__edit')) return;
      const comments = res.data ?? [];
      list.replaceChildren();
      if (!comments.length) {
        const empty = document.createElement('p');
        empty.className = 'task-comments__status';
        empty.textContent = t('tasks.commentsEmpty');
        list.appendChild(empty);
      } else {
        for (const comment of comments) list.appendChild(commentRowNode(comment, { onChanged: load, ctx }));
      }
      if (window.lucide) window.lucide.createIcons({ el: list });
    } catch {
      if (request !== requestSequence || ctx.closed || list.querySelector('.task-comment__edit')) return;
      list.replaceChildren();
      const failed = document.createElement('p');
      failed.className = 'task-comments__status';
      failed.textContent = t('tasks.commentsLoadError');
      list.appendChild(failed);
    }
  };

  // Wer die Aufgaben nur LESEN darf, bekommt die Unterhaltung zu sehen und kein
  // Eingabefeld: die API weist seinen POST mit 403 ab, und ein Formular, das
  // zum Schreiben einlaedt und dann nicht abschickt, ist dieselbe leere Zusage
  // wie der fehlende Knopf, der #700 ausgeloest hat.
  ctx.refreshComments = load;
  if (!canTask(task, 'comment')) {
    wrap.append(list);
    load();
    return wrap;
  }

  const form = document.createElement('form');
  form.className = 'task-comments__form';
  const field = document.createElement('textarea');
  field.className = 'input task-comment__input';
  field.rows = 2;
  field.maxLength = 5000;
  field.placeholder = t('tasks.commentPlaceholder');
  field.setAttribute('aria-label', t('tasks.commentsLabel'));
  const submit = document.createElement('button');
  submit.type = 'submit';
  // Bewusst nicht `--primary`: der auffälligste Knopf im Panel gehört der
  // Fußzeile („Starten", „Ablegen"). Ein leuchtendes „Kommentieren" mitten im
  // Blatt zöge die Aufmerksamkeit auf die Nebensache.
  submit.className = 'btn btn--secondary btn--sm task-comments__submit';
  submit.textContent = t('tasks.commentSubmit');
  const fieldBox = document.createElement('div');
  // Eigener Träger: die Vorschlagsliste hängt relativ darin, nicht am Formular.
  fieldBox.className = 'task-comments__field';
  fieldBox.appendChild(field);
  form.append(fieldBox, submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = field.value.trim();
    if (!value) return;
    submit.disabled = true;
    try {
      await api.post(`/tasks/${task.id}/comments`, { comment: value });
      if (field.value.trim() === value) field.value = '';
      await load();
    } catch (err) {
      window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
    } finally {
      submit.disabled = false;
    }
  });

  wireMentionSuggest(field, ctx);
  wrap.append(list, form);
  load();
  return wrap;
}

/** Erinnerung im Klartext, aus dem gespeicherten Zeitpunkt. */
function taskReminderSummary(reminders) {
  const list = Array.isArray(reminders) ? reminders : (reminders ? [reminders] : []);
  return list
    .map((r) => {
      if (!r?.remind_at) return '';
      const at = parseRemindAtAsUtc(r.remind_at);
      return `${formatDate(at)} ${formatTime(at)}`.trim();
    })
    .filter(Boolean)
    .join(', ');
}

function taskActionNode(task) {
  const action = task.action_link;
  if (!action?.path) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--secondary btn--sm task-detail__linked-action';
  button.textContent = action.label || 'Open';
  button.addEventListener('click', () => {
    const url = new URL(action.path, window.location.origin);
    for (const [key, value] of Object.entries(action.params || {})) {
      if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    closeDetailView();
    window.yuvomi?.navigate(`${url.pathname}${url.search}${url.hash}`);
  });
  return button;
}

function statusSummaryNode(task, ctx) {
  const summary = document.createElement('div');
  summary.className = 'task-detail-summary';
  const control = document.createElement('label');
  control.className = 'task-detail-status';
  const label = document.createElement('span');
  label.textContent = 'Status';
  const select = document.createElement('select');
  select.className = 'input input--sm';
  select.dataset.taskOperation = '';
  select.dataset.immediateAction = '';
  select.dataset.focusKey = 'status';
  select.setAttribute('aria-label', 'Task status');
  for (const [value, text] of [['open', 'Not Started'], ['in_progress', 'In Progress'], ['done', 'Completed']]) {
    const option = document.createElement('option');
    option.value = value; option.textContent = text;
    select.appendChild(option);
  }
  select.value = task.status;
  select.disabled = isArchived(task) || !canTask(task, 'complete');
  select.addEventListener('change', async () => {
    const requested = select.value;
    select.value = task.status;
    await ctx.runMutation(select, () => changeTaskStatus(task, requested));
    if (select.isConnected) select.value = task.status;
  });
  control.append(label, select);
  summary.appendChild(control);
  const priority = priorityNode(task.priority);
  if (priority) summary.appendChild(priority);
  const progress = progressNode(task);
  if (progress) summary.appendChild(progress);
  if (isArchived(task)) {
    const archived = document.createElement('span');
    archived.textContent = `Archived · ${formatDate(task.archived_at)}`;
    summary.appendChild(archived);
  }
  return summary;
}

function metadataNode(task, ctx, reminders) {
  const grid = document.createElement('dl');
  grid.className = 'task-detail-metadata';
  const due = formatDueDate(task.due_date, task.due_time, task.status === 'done' || isArchived(task));
  const recurrence = recurrenceRow(task.recurrence_rule, { fromCompletion: !!task.recurrence_from_completion });
  const entries = [
    [t('tasks.assignedLabel'), participantListNode(task, ctx)],
    [t('tasks.dueDateLabel'), due?.label],
    [t('tasks.startDateLabel'), task.start_date ? formatDate(task.start_date) : null],
    [t('tasks.pointsLabel'), task.points ? String(task.points) : null],
    [recurrence?.label || 'Repeats', recurrence?.node || recurrence?.value],
    [t('tasks.categoryLabel'), task.category && task.category !== FALLBACK_CATEGORY ? catLabel(task.category, ctx.categories) : null],
    [t('tasks.tagsLabel'), tagChipsNode(task.tags)],
    ['Required skills', taskSkillSummary(task, ctx)],
    [t('tasks.locationLabel'), taskLocationNode(task, ctx)],
    ['Availability / Presence', presenceSummary(task)],
    [t('tasks.activityTemplateLabel'), activityTemplateSummary(task)],
    [t('reminders.sectionTitle'), taskReminderSummary(reminders)],
  ];
  for (const [label, value] of entries) {
    if (!value) continue;
    const group = document.createElement('div');
    const term = document.createElement('dt'); term.textContent = label;
    const detail = document.createElement('dd');
    if (value instanceof HTMLElement) detail.appendChild(value); else detail.textContent = value;
    group.append(term, detail); grid.appendChild(group);
  }
  return grid;
}

function supervisionNode(task, ctx) {
  const supervision = task.supervision;
  const action = task.supervision_action;
  const actions = supervision?.actions || (action ? [action] : []);
  if (!actions.length && (!supervision || supervision.state === 'none')) return null;
  const wrap = document.createElement('div');
  wrap.className = 'task-detail-supervision';
  wrap.setAttribute('role', 'status');
  const title = document.createElement('strong');
  title.textContent = ['needed', 'excluded'].includes(supervision?.state) ? 'Supervision needed' : 'Supervised work';
  wrap.appendChild(title);
  if (supervision?.reason) {
    const reason = document.createElement('p'); reason.textContent = supervision.reason; wrap.appendChild(reason);
  }
  for (const requirement of actions) {
    if (requirement.state === 'not_required') continue;
    const row = document.createElement('div'); row.className = 'task-detail-supervision__action';
    const name = document.createElement('strong'); name.textContent = requirement.action_title || task.title;
    const explanation = document.createElement('span');
    const skills = (requirement.required_skills || []).map((skill) => skill.name).join(', ');
    const reason = requirement.reason !== supervision?.reason && requirement.state !== 'assigned' ? requirement.reason : '';
    explanation.textContent = [skills, requirement.supervisor_name ? `Supervisor: ${requirement.supervisor_name}` : 'No supervisor assigned', reason].filter(Boolean).join(' · ');
    row.append(name, explanation);
    if (requirement.counterpart_task_id && !task.is_supervision_projection && supervision?.can_view_support === true) {
      const link = document.createElement('a'); link.href = `/tasks?open=${requirement.counterpart_task_id}`;
      link.textContent = 'Open supervision work'; row.appendChild(link);
    }
    if (canTask(task, 'reassign') && canTask(task, 'change_assignment') && requirement.eligible_supervisors?.length) {
      const controls = document.createElement('div'); controls.className = 'task-detail-supervision__controls';
      const select = document.createElement('select'); select.className = 'input input--sm';
      select.dataset.immediateAction = '';
      select.setAttribute('aria-label', `Supervisor for ${requirement.action_title || task.title}`);
      for (const person of requirement.eligible_supervisors) {
        const option = document.createElement('option'); option.value = person.id; option.textContent = person.display_name;
        option.selected = Number(person.id) === Number(requirement.supervisor_user_id); select.appendChild(option);
      }
      const assign = document.createElement('button'); assign.type = 'button'; assign.className = 'btn btn--secondary btn--sm';
      assign.textContent = 'Assign supervisor'; assign.dataset.taskOperation = '';
      assign.addEventListener('click', () => ctx.runMutation(assign, () => api.post(`/tasks/${requirement.action_task_id}/supervisor`, {
        supervisor_user_id: Number(select.value), expected_revision: requirement.task_revision,
        ...(Number(requirement.action_task_id) !== Number(supervision?.source_task_id) ? { expected_parent_revision: supervision?.source_revision } : {}),
      })));
      controls.append(select, assign); row.appendChild(controls);
    }
    wrap.appendChild(row);
  }
  return wrap;
}

function activityNode(task, ctx) {
  const wrap = document.createElement('div'); wrap.className = 'task-detail-activity';
  const status = document.createElement('p'); status.className = 'form-hint'; status.textContent = t('common.loading');
  wrap.appendChild(status);
  const labels = { created: 'Created', assigned: 'Assigned', reassigned: 'Reassigned', supervisor_assigned: 'Supervisor assigned',
    started: 'Started', subtask_completed: 'Subtask completed', subtask_reopened: 'Subtask reopened', reset: 'Progress reset', completed: 'Completed', reopened: 'Reopened', edited: 'Edited', status_changed: 'Status changed' };
  ctx.activityRequest = api.get(`/tasks/${task.id}/activity`);
  ctx.activityRequest.then((response) => {
    if (ctx.closed || !wrap.isConnected) return;
    wrap.replaceChildren();
    const rows = response.data || [];
    if (!rows.length) { status.textContent = 'No activity recorded yet.'; wrap.appendChild(status); }
    for (const entry of rows) {
      const row = document.createElement('p');
      const detail = entry.details || {};
      row.textContent = [labels[entry.event_type] || String(entry.event_type || 'Updated').replaceAll('_', ' '), detail.title,
        entry.actor_name, `${formatDate(entry.created_at)} ${formatTime(entry.created_at)}`].filter(Boolean).join(' · ');
      wrap.appendChild(row);
    }
  }).catch(() => { status.textContent = 'Activity could not be loaded.'; });
  return wrap;
}

function secondaryMetadataNode(task, ctx) {
  const values = [assignmentSummary(task), task.locked ? t('tasks.lockedDetail') : '',
    visibilityRow(task.visibility)?.value, task.countdown && task.due_date ? t('tasks.countdownDetail') : ''].filter(Boolean);
  const responsibilities = responsibilityListNode(task, ctx);
  if (!values.length && !responsibilities) return null;
  const details = document.createElement('details'); details.className = 'task-detail-secondary';
  const summary = document.createElement('summary'); summary.textContent = 'More details'; details.appendChild(summary);
  for (const value of values) { const line = document.createElement('p'); line.textContent = value; details.appendChild(line); }
  if (responsibilities) details.appendChild(responsibilities);
  return details;
}

function renderTaskDetail(task, reminders = [], ctx) {
  return [
    { node: statusSummaryNode(task, ctx) },
    { label: 'Instructions', node: descriptionNode(task, ctx), multiline: true },
    { label: t('tasks.subtasksLabel'), node: subtaskListNode(task, ctx) },
    { node: supervisionNode(task, ctx) },
    { node: metadataNode(task, ctx, reminders) },
    { node: secondaryMetadataNode(task, ctx) },
    { label: 'Open', node: taskActionNode(task) },
    { label: t('tasks.documentsLabel'), node: documentListNode(task.documents) },
    { label: t('tasks.commentsLabel'), node: commentsNode(task, ctx) },
    { label: 'Activity', node: activityNode(task, ctx) },
    task.is_recurring ? { label: t('tasks.historySeriesTitle'), node: seriesHistoryNode(task, ctx) } : null,
  ];
}

/**
 * Die Notiz als gerendertes Markdown (#731).
 *
 * `renderMarkdownLight` liegt seit Langem in utils/html.js und wird von den
 * Notizen und vom Dashboard benutzt - die Aufgaben waren die einzige Stelle, die
 * denselben Freitext als rohen String ausgab. Es ist also kein neuer Baustein,
 * sondern ein nicht angeschlossener; entsprechend teilen sich beide auch die
 * `note-md-*`-Klassen, damit eine Liste hier nicht anders aussieht als dort.
 *
 * Der Renderer maskiert selbst, deshalb ist insertAdjacentHTML hier zulaessig -
 * dieselbe Zusicherung, auf der notes.js und dashboard.js bereits stehen.
 */
function descriptionNode(task, ctx) {
  const text = (task.description ?? '').trim();
  if (!text) return null;
  const box = document.createElement('div');
  box.className = 'task-detail__note';
  // Interaktiv, weil diese Ansicht beides kann, was der Renderer dafür
  // verlangt: sie zeigt den VOLLSTÄNDIGEN Text (die Zeilennummern am Kästchen
  // sind also die der Aufgabe) und sie kennt die Aufgaben-Id. Das Dashboard und
  // die Kalender-Chips bekommen diese Optionen deshalb ausdrücklich nicht.
  box.insertAdjacentHTML('beforeend', renderMarkdownLight(text, {
    checklist: { interactive: canTask(task, 'complete'), toggleLabel: t('tasks.checklistToggle') },
  }));
  box.addEventListener('click', (e) => {
    const hit = e.target.closest('.note-md-box[data-md-line]');
    if (hit && canTask(task, 'complete')) toggleDescriptionCheck(task, hit, ctx);
  });
  return box;
}

/**
 * Einen Haken in der Beschreibung setzen oder lösen (#917).
 *
 * Optimistisch wie bei den Notizen und bei den Teilaufgaben: ein Abhaken, das
 * erst nach der Antwort reagiert, fühlt sich wie ein verschluckter Tap an - und
 * genau auf dem Wandtablett ist das die ganze Interaktion.
 *
 * `expect` ist die Gegenprobe zum Zeilenindex: hat jemand den Text inzwischen
 * bearbeitet, zeigt der Index woanders hin, und ein Haken in der falschen Zeile
 * wäre schlimmer als eine Fehlermeldung. Der Server antwortet dann mit 409.
 *
 * Der lokale Stand wird aus der ANTWORT nachgezogen, nicht selbst gerechnet:
 * sonst liefe `expect` beim zweiten Tap gegen einen Text, den nur der Client
 * kennt.
 */
async function toggleDescriptionCheck(task, box, ctx) {
  const line    = parseInt(box.dataset.mdLine, 10);
  const checked = box.dataset.mdChecked !== '1';
  const expect  = splitKeepingLineEndings(task.description)[line * 2];

  // Der eigene Stand kennt die angetippte Zeile gar nicht mehr - dasselbe
  // Ergebnis wie ein 409, nur ohne den Umweg über den Server. Ausdrücklich
  // nicht stilles Nichtstun, sonst täte ein Tap einfach nichts.
  if (expect === undefined) {
    window.yuvomi?.showToast(t('tasks.checkConflict'), 'danger');
    return;
  }

  const paint = (on) => {
    box.setAttribute('aria-checked', String(on));
    box.dataset.mdChecked = on ? '1' : '0';
    box.closest('.note-md-check')?.classList.toggle('is-checked', on);
  };

  paint(checked);
  try {
    const res = await api.patch(`/tasks/${task.id}/check`, { line, checked, expect, ...taskRevision(task) });
    if (Number(res.data?.revision || 0) >= Number(task.revision || 0)) Object.assign(task, res.data);
    await ctx.refresh();
  } catch (err) {
    paint(!checked);
    if (err.status === 409) await ctx.refresh();
    window.yuvomi?.showToast(
      err.status === 409 ? t('tasks.checkConflict') : (err.data?.error ?? t('common.unknownError')),
      'danger',
    );
  }
}

/**
 * Der eine Einstieg in eine bestehende Aufgabe - fuer jede Ansicht, die eine
 * anbietet (#918).
 *
 * Anders als beim Kalender wird hier bewusst kein Anker übergeben: Eine Aufgabe
 * trägt deutlich mehr Inhalt als ein Termin, und ein 320px-Popover neben der
 * Zeile wäre für Teilaufgaben, Tags und Dokumente zu eng.
 *
 * WAS DIE ANSICHT VON IHRER UMGEBUNG BRAUCHT, STEHT IM AUFRUF. Sie las den
 * Betrachter und die Kategorien früher aus dem `state` der Aufgabenseite und
 * lud diese Seite nach jeder Änderung neu - beides Wissen, das nur dort
 * existiert. Damit war sie an ihr Modul genagelt, und die Übersicht bot
 * stattdessen ein Kärtchen mit zwei Knöpfen an, weil ihr der Rest nicht zur
 * Verfügung stand. Jetzt sagt der Aufrufer, wer schaut (`currentUserId`,
 * `isAdmin`), was er anzeigen kann (`users`, `categories`) und wie er sich
 * selbst auffrischt (`onChanged`) - der Kalender frischt seinen Tag auf, das
 * Widget seine Kachel, die Liste ihre Karten.
 *
 * `edit` ist bewusst injiziert und nicht eingebaut: das Formular gehört dem
 * Aufgabenmodul, nicht der Leseansicht. Wer keinen Mounter mitgibt, bekommt
 * eine Ansicht ohne Bearbeiten-Knopf statt einen, der ins Leere führt.
 *
 * `container` dient allein dazu, die Zeile der Aufgabe beim Löschen sofort
 * auszublenden; wer keinen mitgibt, sieht sie erst nach `onChanged` gehen.
 *
 * @param {{
 *   task: object,
 *   reminder?: object|object[]|null,
 *   users?: object[],
 *   currentUserId?: number|string|null,
 *   isAdmin?: boolean,
 *   categories?: object[],
 *   container?: HTMLElement|null,
 *   onChanged?: () => (void|Promise<void>),
 *   edit?: {mount: (panel: HTMLElement, pane: HTMLElement) => void}|null,
 * }} options
 */
export function openTaskDetail({
  task,
  reminder = null,
  users = [],
  skills = null,
  currentUserId = null,
  isAdmin = false,
  categories = [],
  container = null,
  onChanged = () => {},
  edit = null,
}) {
  const ctx = { task, users, skills, currentUserId, isAdmin, categories, container, onChanged };
  ctx.refresh = async () => { if (!ctx.closed) await ctx.loader?.load(); };
  ctx.runMutation = async (button, operation) => {
    if (ctx.busy) return;
    ctx.busy = true;
    button.disabled = true;
    ctx.loader?.invalidate();
    try {
      const result = await operation();
      if (result !== null) { await ctx.refresh(); await ctx.onChanged(); }
    } catch (error) {
      if (error.status === 409) await ctx.refresh();
      window.yuvomi?.showToast(error.status === 409
        ? (error.data?.error || 'This Task changed. Review its current state before trying again.')
        : error.message, 'danger');
    } finally { ctx.busy = false; if (button.isConnected) button.disabled = false; }
  };

  const archived = isArchived(task);

  // Gesperrte Aufgabe (#830): der Weiterschalt-Knopf bleibt, Loeschen, Ablegen
  // und Bearbeiten fallen weg. Die Detailansicht ist der zweite Einstieg neben
  // der Zeile - blendete nur die Zeile aus, waere die Sperre hier zu umgehen.
  const canEdit = canTask(task, 'edit') && canEditTaskDefinition(task, null, ctx);

  const actions = canTask(task, 'delete_archive') && canEditTaskDefinition(task, null, ctx) ? [{
    id: 'task-detail-delete',
    label: t('common.delete'),
    variant: 'danger-ghost',
    icon: 'trash-2',
    align: 'start',
    // Siehe closeDetailView: nach dem Löschen gibt es nichts mehr zu verwerfen,
    // und der await hält die optimistische Löschung zurück, bis der
    // Overlay-Slot frei ist.
    onClick: async ({ close }) => {
      await close({ force: true });
      deleteTaskWithUndo(String(task.id), ctx);
    },
  }] : [];

  if (!archived && canTask(task, 'claim') && (task.activity_assignment_state === 'open' || task.activity_assignment_state === 'unavailable')) {
    actions.push({
      id: 'task-detail-claim',
      label: t('tasks.claimTask'),
      variant: 'primary',
      icon: 'hand',
      onClick: ({ button }) => claimOpenTask(task, button, ctx),
    });
  }

  // Ablegen und Zurückholen sind derselbe Schalter - was er tut, hängt daran, wo
  // die Aufgabe gerade liegt.
  if (canTask(task, 'delete_archive') && canEditTaskDefinition(task, null, ctx)) {
    actions.push({
      id: 'task-detail-archive',
      label: archived ? t('tasks.unarchiveButton') : t('tasks.archiveButton'),
      variant: 'ghost',
      icon: archived ? 'archive-restore' : 'archive',
      onClick: ({ button }) => toggleTaskArchive(task, button, ctx),
    });
  }

  const view = openDetailView({
    title: task.title,
    size: 'lg',
    sections: renderTaskDetail(task, reminder, ctx),
    actions,
    onClose: () => { ctx.closed = true; ctx.loader?.dispose(); ctx.stopLive?.(); },
    edit: canEdit && edit ? {
      label: t('common.edit'),
      title: t('tasks.editTask'),
      mount: (panel, pane) => edit.mount(panel, pane),
    } : undefined,
  });
  ctx.loader = latestTaskLoader(() => api.get(`/tasks/${task.id}`), (response) => {
    if (!view.isOpen()) return;
    const fresh = response.data;
    if (!fresh || Number(fresh.revision || 0) < Number(task.revision || 0)) return;
    Object.assign(task, fresh);
    const pane = document.querySelector('.detail-view__pane');
    const body = pane?.closest('.modal-panel__body');
    const scroll = body?.scrollTop;
    const draftField = ctx.comments?.contains(document.activeElement) ? document.activeElement : null;
    const selection = draftField?.selectionStart == null ? null : [draftField.selectionStart, draftField.selectionEnd];
    const focus = pane?.contains(document.activeElement) ? document.activeElement?.dataset.focusKey : null;
    view.update(renderTaskDetail(task, reminder, ctx));
    if (body && scroll != null) body.scrollTop = scroll;
    if (focus) pane?.querySelector(`[data-focus-key="${focus}"]`)?.focus({ preventScroll: true });
    if (draftField?.isConnected) { draftField.focus({ preventScroll: true }); if (selection) draftField.setSelectionRange(...selection); }
    const commentsForm = ctx.comments?.querySelector('.task-comments__form');
    if (commentsForm) {
      commentsForm.hidden = !canTask(task, 'comment');
      commentsForm.querySelectorAll('input, textarea, button').forEach(control => { control.disabled = !canTask(task, 'comment'); });
    }
    for (const [id, permission] of [['detail-view-edit', 'edit'], ['task-detail-delete', 'delete_archive'], ['task-detail-archive', 'delete_archive'], ['task-detail-claim', 'claim']]) {
      const control = document.getElementById(id);
      if (control) control.hidden = !canTask(task, permission);
    }
    const editing = document.querySelector('.detail-view__form');
    if (!editing || editing.hidden) {
      const title = document.getElementById('shared-modal-title');
      if (title) title.textContent = task.title;
    }
    ctx.refreshComments?.();
  });
  ctx.stopLive = watchTaskChanges(() => { void ctx.refresh().catch((error) => {
    if ([403, 404].includes(error.status) && view.isOpen()) {
      ctx.closed = true; ctx.stopLive?.();
      view.update([{ label: 'Task unavailable', value: 'This Task was removed or you no longer have access.' }]);
    }
  }); });
  return view;
}

async function claimOpenTask(task, button, ctx) {
  const stop = btnLoading(button);
  try {
    await api.post(`/automation/tasks/${task.id}/claim`, taskRevision(task));
    task.activity_assignment_state = 'assigned';
    await closeDetailView({ force: true });
    window.yuvomi.showToast(t('tasks.claimedToast'), 'success');
    await ctx.onChanged();
  } catch (err) {
    stop();
    window.yuvomi.showToast(err.data?.error || err.message || t('common.errorGeneric'), 'danger');
  }
}

/**
 * Ablegen bzw. Zurückholen aus der Detailansicht. Wie advanceTaskStatus schließt
 * die Ansicht danach: die Aufgabe wechselt die Liste, und ein Panel, das über
 * einem verschwundenen Eintrag stehen bleibt, hat nichts mehr zu zeigen.
 */
async function toggleTaskArchive(task, button, ctx) {
  const stop = btnLoading(button);
  const archived = isArchived(task);
  try {
    await setTaskArchived(task.id, !archived, task);
    task.archived_at = archived ? null : new Date().toISOString();
    await closeDetailView({ force: true });
    window.yuvomi.showToast(archived ? t('tasks.unarchivedToast') : t('tasks.archivedToast'), 'success');
    await ctx.onChanged();
  } catch (err) {
    stop();
    window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
  }
}

/**
 * „Zuletzt erledigt" für die Detailansicht - über die ganze Wiederholungskette,
 * nicht nur für die Instanz, die gerade offen daliegt.
 *
 * Nachgeladen statt mitgeliefert: die Aufgabenliste holt Dutzende Zeilen, und
 * eine Historie an jeder davon wäre Ladearbeit für eine Zeile, die man erst
 * beim Öffnen sieht.
 */
function seriesHistoryNode(task, ctx = {}) {
  // Ohne eigene Ueberschrift: die Detailzeile traegt ihr Label schon, und eine
  // zweite daneben saehe aus wie ein zweiter Abschnitt.
  const list = document.createElement('div');
  list.className = 'detail-history';
  const placeholder = document.createElement('p');
  placeholder.className = 'detail-history__empty';
  placeholder.textContent = t('common.loading');
  list.appendChild(placeholder);

  const activityRequest = ctx.activityRequest;
  api.get(`/tasks/${task.id}/completions?limit=10`).then(async (res) => {
    const entries = res.data ?? [];
    const activity = !entries.length && activityRequest ? await activityRequest.catch(() => ({ data: [] })) : null;
    if (ctx.closed || !list.isConnected) return;
    list.replaceChildren();
    if (!entries.length) {
      const none = document.createElement('p');
      none.className = 'detail-history__empty';
      const completed = activity?.data?.find(entry => entry.event_type === 'completed' && Number(entry.action_task_id) === Number(task.id));
      none.textContent = completed
        ? [`${formatDate(completed.created_at)} ${formatTime(completed.created_at)}`, completed.actor_name,
          'Historical completion retained in Activity.'].filter(Boolean).join(' · ')
        : 'No completed occurrences currently recorded.';
      list.appendChild(none);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('p');
      row.className = 'detail-history__row';
      const when = document.createElement('span');
      when.className = 'detail-history__when';
      when.textContent = `${historyDayLabel(zonedDateKey(entry.completed_at))}, ${formatTime(entry.completed_at)}`;
      const who = document.createElement('span');
      who.className = 'detail-history__who';
      who.textContent = entry.user_name || t('tasks.historyUnknownMember');
      row.append(when, who);
      list.appendChild(row);
    }
  }).catch(() => {
    list.replaceChildren();
    const failed = document.createElement('p');
    failed.className = 'detail-history__empty';
    failed.textContent = t('tasks.historySeriesLoadError');
    list.appendChild(failed);
  });

  return list;
}
