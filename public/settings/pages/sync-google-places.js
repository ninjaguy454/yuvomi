import { renderGooglePlacesSettings } from '/components/google-places-settings.js';

export async function render(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <div class="settings-card">
        <div id="google-places-settings"></div>
      </div>
    </section>`);

  await renderGooglePlacesSettings(container.querySelector('#google-places-settings'));
}
