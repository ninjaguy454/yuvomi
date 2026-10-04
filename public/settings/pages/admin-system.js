import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { isPermAdmin } from '/permissions.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import {
  createInfoList,
  createRetryState,
  createStatusSummary,
} from '/settings/components.js';

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.systemTitle')}</h2>
      ${isPermAdmin() ? '<div class="settings-card" id="household-profile-host"></div>' : ''}
      <div class="settings-card" id="system-info-card">
        <div id="system-info-host"></div>
      </div>
    </section>
  `);
}

function buildInfoRows(info) {
  const rows = [];

  if (info.version) {
    rows.push({
      label: t('settings.systemVersionLabel'),
      value: t('settings.systemVersionValue', { version: info.version }),
    });
  }
  rows.push({
    label: t('settings.systemLicenseLabel'),
    value: 'MIT',
  });
  rows.push({
    label: t('settings.systemSetupStatusLabel'),
    value: info.setup_required
      ? t('settings.systemSetupRequired')
      : t('settings.systemSetupComplete'),
  });

  return rows;
}

function renderInfo(host, info) {
  host.replaceChildren(createInfoList(buildInfoRows(info)));
}

async function loadSystemInfo(container) {
  const host = container.querySelector('#system-info-host');
  if (!host) return;

  const reload = () => loadSystemInfo(container);

  let info;
  try {
    info = await api.get('/version');
  } catch (err) {
    host.replaceChildren(createRetryState({
      message: err.message || t('common.errorGeneric'),
      onRetry: reload,
    }));
    return;
  }

  if (!info?.version) {
    host.replaceChildren(createStatusSummary({
      title: t('settings.systemTitle'),
      status: t('settings.loadError'),
      tone: 'warning',
    }));
    return;
  }

  renderInfo(host, info);
  window.lucide?.createIcons({ el: container });
}

export async function render(container, { user } = {}) {
  void user;
  renderPage(container);
  await Promise.all([loadSystemInfo(container), loadHouseholdProfile(container)]);
  window.lucide?.createIcons({ el: container });
}

async function loadHouseholdProfile(container) {
  const host = container.querySelector('#household-profile-host');
  if (!host || !isPermAdmin()) return;
  try {
    const preferences = await getPreferences();
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', `<form id="household-profile-form" class="settings-form">
      <div class="form-group"><label class="form-label" for="household-family-name">${t('pairedDisplay.familyName')}</label>
        <input class="form-input" id="household-family-name" name="family_name" type="text" maxlength="80" value="${esc(preferences.family_name || '')}" aria-describedby="household-family-name-hint">
        <p class="form-hint" id="household-family-name-hint">${t('pairedDisplay.familyNameHint')}</p>
      </div>
      <p id="household-profile-status" role="status" hidden></p>
      <button class="btn btn--primary" type="submit">${t('common.save')}</button>
    </form>`);
    const form = host.querySelector('form');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const submit = form.querySelector('[type="submit"]'), status = host.querySelector('#household-profile-status');
      if (submit.disabled) return;
      submit.disabled = true;
      try {
        const result = await savePreferences({ family_name: form.elements.family_name.value });
        form.elements.family_name.value = result.data.family_name;
        form.elements.family_name.defaultValue = result.data.family_name;
        status.textContent = t('pairedDisplay.familyNameSaved');
      } catch (error) { status.textContent = error.message || t('common.errorGeneric'); }
      finally { status.hidden = false; submit.disabled = false; }
    });
  } catch (error) {
    host.replaceChildren(createRetryState({ message: error.message || t('common.errorGeneric'), onRetry: () => loadHouseholdProfile(container) }));
  }
}
