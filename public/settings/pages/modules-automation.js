import { renderAutomationManager } from '/components/activity-automation.js';
import { t } from '/i18n.js';

const AUTOMATION_TABS = new Set(['skills', 'activities', 'workflows', 'variables']);

function selectedTab(query) {
  const tab = query?.get('tab');
  return AUTOMATION_TABS.has(tab) ? tab : 'skills';
}

export async function render(container, { user, query } = {}) {
  void user;
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <div class="settings-card settings-card--automation">
        <p class="form-hint automation-settings-intro">
          ${t('settings.pageHouseholdAutomationDescription')}
        </p>
        <div id="settings-automation-manager"></div>
      </div>
    </section>
  `);

  const manager = container.querySelector('#settings-automation-manager');
  if (!manager) return;

  const showTab = async (tab, updateUrl = true) => {
    const activeTab = AUTOMATION_TABS.has(tab) ? tab : 'skills';
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', activeTab);
      history.replaceState(history.state, '', url);
    }
    await renderAutomationManager(manager, { tab: activeTab, onTabChange: showTab });
  };

  await showTab(selectedTab(query), false);
}
