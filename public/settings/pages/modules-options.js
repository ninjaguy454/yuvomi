import { t } from '/i18n.js';
import { toggleRowHtml } from '/settings/components.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';

/**
 * Modul-Schalter, die vor dem IA-Umbau je ein eigenes Blatt hatten: Budget,
 * Gesundheit und Haushaltshilfe trugen zusammen drei Checkboxen, kosteten aber
 * drei Sidebar-Einträge, drei Navigationsschritte und drei Requests
 * (Critique 2026-07-27). Ein Schalter je Karte, ein Blatt. Aufgaben kam später
 * nach demselben Muster dazu.
 */
const APPEARANCE_PATH = '/settings/personal/appearance';

const TOGGLES = [
  {
    id: 'budget-mode-personal',
    key: 'budget_mode',
    // Der einzige Nicht-Boolean: die Route erwartet den Modus als String.
    read: (preferences) => preferences.budget_mode === 'personal',
    payload: (checked) => ({ budget_mode: checked ? 'personal' : 'shared' }),
    savedKey: 'settings.budgetModeSaved',
  },
  {
    id: 'health-cycle-enabled',
    key: 'health_cycle_enabled',
    read: (preferences) => preferences.health_cycle_enabled !== false,
    payload: (checked) => ({ health_cycle_enabled: checked }),
    savedKey: 'settings.healthCycleSaved',
  },
  {
    id: 'housekeeping-payment-tasks',
    key: 'housekeeping_payment_tasks',
    read: (preferences) => Boolean(preferences.housekeeping_payment_tasks),
    payload: (checked) => ({ housekeeping_payment_tasks: checked }),
    savedKey: 'settings.housekeepingPaymentTasksSaved',
  },
  {
    id: 'tasks-subtasks-expanded',
    key: 'tasks_subtasks_expanded',
    read: (preferences) => Boolean(preferences.tasks_subtasks_expanded),
    payload: (checked) => ({ tasks_subtasks_expanded: checked }),
    savedKey: 'settings.tasksSubtasksExpandedSaved',
  },
];

function checkedState(preferences) {
  return new Map(TOGGLES.map((toggle) => [toggle.id, toggle.read(preferences)]));
}

function renderPage(container, preferences) {
  const checked = checkedState(preferences);
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionBudget')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.budgetModeTitle')}</h3>
        <p class="form-hint">${t('settings.budgetModeHint')}</p>
        ${toggleRowHtml({
          label: t('settings.budgetModePersonalLabel'),
          checked: checked.get('budget-mode-personal'),
          attrs: { id: 'budget-mode-personal' },
        })}
        <p class="form-hint">
          ${t('settings.currencyMovedHint')}
          <a href="${APPEARANCE_PATH}" id="budget-region-link">${t('settings.regionTitle')}</a>
        </p>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('nav.health')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('health.tabs.cycle')}</h3>
        <p class="form-hint">${t('settings.healthCycleHint')}</p>
        ${toggleRowHtml({
          label: t('settings.healthCycleEnableLabel'),
          checked: checked.get('health-cycle-enabled'),
          attrs: { id: 'health-cycle-enabled' },
        })}
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionHousekeeping')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.housekeepingPaymentsTitle')}</h3>
        <p class="form-hint">${t('settings.housekeepingPaymentTasksHint')}</p>
        ${toggleRowHtml({
          label: t('settings.housekeepingPaymentTasksLabel'),
          checked: checked.get('housekeeping-payment-tasks'),
          attrs: { id: 'housekeeping-payment-tasks' },
        })}
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('nav.tasks')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.tasksSubtasksExpandedTitle')}</h3>
        ${toggleRowHtml({
          label: t('settings.tasksSubtasksExpandedLabel'),
          checked: checked.get('tasks-subtasks-expanded'),
          attrs: { id: 'tasks-subtasks-expanded' },
        })}
      </div>
    </section>
  `);
}

function bindEvents(container) {
  const link = container.querySelector('#budget-region-link');
  link?.addEventListener('click', (event) => {
    if (!window.yuvomi?.navigate) return;
    event.preventDefault();
    window.yuvomi.navigate(APPEARANCE_PATH);
  });

  for (const toggle of TOGGLES) {
    const input = container.querySelector(`#${toggle.id}`);
    input?.addEventListener('change', async () => {
      input.disabled = true;
      try {
        await savePreferences(toggle.payload(input.checked));
        window.yuvomi?.showToast(t(toggle.savedKey), 'success');
      } catch (error) {
        input.checked = !input.checked; // Rollback nur bei Save-Fehler
        window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
      } finally {
        if (input.isConnected) input.disabled = false;
      }
    });
  }
}

export async function render(container, { user }) {
  void user;
  const preferences = await getPreferences();
  renderPage(container, preferences);
  bindEvents(container);
}
