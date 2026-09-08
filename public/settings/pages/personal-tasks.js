import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { caldavTargetValue, SYNC_TARGET_LOCAL } from '/utils/sync-target.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import { toggleRowHtml } from '/settings/components.js';

/**
 * Standardwerte, die nur für die eigenen neuen Aufgaben gelten (#695).
 *
 * Eigenes Blatt und nicht in `sync-reminders`: welche Erinnerungslisten der
 * Haushalt überhaupt abgleicht, ist eine Admin-Entscheidung, in welche davon
 * MEINE neuen Aufgaben laufen, ist meine. `preferences.js` schreibt den Wert
 * entsprechend per `cfgUserSet`. Derselbe Fehler steckte schon einmal in
 * `modules-calendar` (Critique 2026-07-27), und dort kamen fünf von sechs
 * Familienmitgliedern nie an ihre eigenen Vorgaben.
 */

/**
 * Optionen des Standard-Ziel-Dropdowns.
 *
 * Bewusst nicht über buildSyncTargetOptions: die Aufgaben kennen kein
 * Google-Ziel und keine Kalender, sondern Erinnerungslisten. Die Kennung selbst
 * kommt trotzdem aus dem geteilten Util - sie ist dieselbe Form wie beim
 * Kalender, und genau dafür gibt es das Modul.
 */
export function reminderTargetOptions(lists, labels, current = '') {
  const options = [{ value: SYNC_TARGET_LOCAL, label: labels.local, group: null }];

  for (const list of lists || []) {
    options.push({
      value: caldavTargetValue(list.accountId, list.listUrl),
      label: list.listName || list.listUrl,
      group: list.accountName,
    });
  }

  // Ein gespeichertes, aber nicht mehr angebotenes Ziel als eigene Option
  // nachtragen: sonst zeigte die Oberfläche "nur lokal", während in der
  // Datenbank etwas anderes steht - und es gäbe keinen Weg, es abzuwählen.
  if (current && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: labels.unavailable, group: null });
  }

  return options;
}

function targetFieldHtml(options, current) {
  let html = '';
  let openGroup = null;
  for (const option of options) {
    if (option.group !== openGroup) {
      if (openGroup) html += '</optgroup>';
      openGroup = option.group;
      if (openGroup) html += `<optgroup label="${esc(openGroup)}">`;
    }
    const selected = option.value === current ? ' selected' : '';
    html += `<option value="${esc(option.value)}"${selected}>${esc(option.label)}</option>`;
  }
  if (openGroup) html += '</optgroup>';

  return `
        <div class="form-group">
          <label class="form-label" for="tasks-default-target">${t('settings.tasksDefaultTargetLabel')}</label>
          <select id="tasks-default-target" class="form-input">${html}</select>
          <p class="form-hint">${t('settings.tasksDefaultTargetHint')}</p>
        </div>
  `;
}

function renderPage(container, preferences, lists = null) {
  const current = preferences.tasks_default_target || '';
  // Das Feld erscheint nur, wenn es etwas zu wählen gibt - ohne freigegebene
  // Erinnerungsliste bliebe ein Dropdown mit der einzigen Option "nur lokal".
  // Ist die Abfrage selbst gescheitert (lists === null), bleibt es ebenfalls
  // weg: dann ist unbekannt, was zur Wahl stünde.
  const options = lists ? reminderTargetOptions(lists, {
    local: t('tasks.syncTargetLocal'),
    unavailable: t('settings.tasksDefaultTargetUnavailable'),
  }, current) : [];

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <!-- Bewusst NICHT der Blatt-Titel: die Shell zeigt ihn bereits darüber,
           und ein h2, das ihn wiederholt, ist eine Überschrift ohne Aussage
           (Guard in test-typography.js). -->
      <h2 class="settings-section__title">${t('settings.tasksDefaultsTitle')}</h2>
      <div class="settings-card">
        ${toggleRowHtml({ label: 'Warn before replacing an edited Task draft', checked: preferences.tasks_template_switch_warning !== false, attrs: { id: 'tasks-template-switch-warning' } })}
        <p class="form-hint">Applies when switching Activity Templates in New Task. Untouched drafts switch immediately.</p>
        <p class="settings-card-description">${t('settings.tasksDefaultsDescription')}</p>
${options.length > 1 ? targetFieldHtml(options, current) : `        <p class="form-hint">${t('settings.tasksDefaultTargetEmpty')}</p>`}
      </div>
    </section>
  `);
}

// Instant-Save mit Rollback auf den letzten gespeicherten Wert, damit ein
// abgelehnter Wert nicht sichtbar stehenbleibt.
function bindEvents(container) {
  const warning = container.querySelector('#tasks-template-switch-warning');
  warning?.addEventListener('change', async () => {
    const value = warning.checked;
    warning.disabled = true;
    try { await savePreferences({ tasks_template_switch_warning: value }); }
    catch (error) { warning.checked = !value; window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger'); }
    finally { warning.disabled = false; }
  });
  const select = container.querySelector('#tasks-default-target');
  if (!select) return;

  let persisted = select.value;
  select.addEventListener('change', async () => {
    const value = select.value;
    select.disabled = true;
    try {
      await savePreferences({ tasks_default_target: value });
      persisted = value;
      window.yuvomi?.showToast(t('settings.tasksDefaultsSaved'), 'success');
    } catch (error) {
      select.value = persisted;
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      if (select.isConnected) select.disabled = false;
    }
  });
}

export async function render(container, { user }) {
  void user;
  const [preferences, lists] = await Promise.all([
    getPreferences(),
    api.get('/tasks/sync-targets')
      .then((res) => res.data?.caldav || [])
      .catch(() => null),
  ]);
  renderPage(container, preferences, lists);
  bindEvents(container);
}
