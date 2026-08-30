import { renderGooglePlacesSettings } from '/components/google-places-settings.js';
import { t } from '/i18n.js';

export async function render(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <p class="settings-section__description">${t('settings.pageGooglePlacesDescription')}</p>
      <div class="settings-card">
        <div id="google-places-settings"></div>
      </div>
    </section>`);

  await renderGooglePlacesSettings(container.querySelector('#google-places-settings'));
}
