import { api } from '/api.js';
import { esc } from '/utils/html.js';

function replaceHtml(element, html) {
  element.replaceChildren();
  element.insertAdjacentHTML('afterbegin', html);
}

function inputRow(label, control, hint = '') {
  return `<div class="form-group">
    <label class="label">${esc(label)}</label>
    ${control}
    ${hint ? `<small class="form-hint">${esc(hint)}</small>` : ''}
  </div>`;
}

function showError(host, message) {
  const error = host.querySelector('[data-google-places-error]');
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

/**
 * Render the server-side Google Places configuration in either a Settings leaf
 * or the Places address-book modal. The API key is write-only and is never
 * placed back into the DOM after it has been saved.
 */
export async function renderGooglePlacesSettings(container, {
  modal = false,
  onSaved = null,
} = {}) {
  replaceHtml(container, '<p class="form-hint">Loading Google Places settings…</p>');

  let config;
  try {
    config = (await api.get('/planning/admin/place-search-config')).data;
  } catch (error) {
    replaceHtml(container, `<div class="form-error" role="alert">${esc(error.message || 'Could not load Google Places settings.')}</div>
      <button type="button" class="btn btn--secondary" data-google-places-retry>Try again</button>`);
    container.querySelector('[data-google-places-retry]')?.addEventListener('click', () => {
      renderGooglePlacesSettings(container, { modal, onSaved });
    });
    return;
  }

  const managed = config.managed_by_environment || {};
  const lockedHint = 'Managed by this Docker container and cannot be changed here.';
  const lock = (field) => managed[field] ? ` disabled aria-describedby="google-${field}-managed"` : '';
  const sourceLabel = config.api_key_source === 'environment'
    ? 'An API key is supplied by the Docker environment.'
    : config.api_key_configured
      ? 'A saved API key is configured. Leave this blank to keep it.'
      : 'No API key is saved yet.';
  const footer = modal
    ? `<div class="modal-panel__footer">
        <button type="button" class="btn btn--secondary" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn btn--primary">Save Google settings</button>
      </div>`
    : '<div class="settings-form-actions"><button type="submit" class="btn btn--primary">Save Google settings</button></div>';

  replaceHtml(container, `<form data-google-places-config>
    <p class="settings-card-description">Google search is optional. The API key stays on the Yuvomi server and is never returned to the browser after it is saved.</p>
    ${inputRow('Google Maps Platform API key', `<input class="input" type="password" name="api_key" maxlength="500" autocomplete="off" placeholder="${config.api_key_configured ? 'Saved - leave blank to keep' : 'Paste API key'}"${lock('api_key')}>`, sourceLabel)}
    ${managed.api_key ? `<p class="form-hint" id="google-api_key-managed">${lockedHint}</p>` : ''}
    <label class="automation-check-row"><input type="checkbox" name="integration_enabled" ${config.integration_enabled ? 'checked' : ''}${lock('integration_enabled')}> Enable Google Places search</label>
    ${managed.integration_enabled ? `<p class="form-hint" id="google-integration_enabled-managed">${lockedHint}</p>` : ''}
    <label class="automation-check-row"><input type="checkbox" name="terms_accepted" ${config.terms_accepted ? 'checked' : ''}${lock('terms_accepted')}> I have reviewed and accept the Google Maps Platform terms for this household's use</label>
    ${managed.terms_accepted ? `<p class="form-hint" id="google-terms_accepted-managed">${lockedHint}</p>` : ''}
    <p class="form-hint"><a href="https://developers.google.com/maps/terms" target="_blank" rel="noopener noreferrer">Review Google Maps Platform terms</a>. Enable the Places API (New) and billing in the Google Cloud project for this key.</p>
    <div class="automation-workflow-condition">
      ${inputRow('Requests per person / minute', `<input class="input" type="number" name="per_user_per_minute" min="1" max="120" required value="${esc(config.per_user_per_minute)}"${lock('per_user_per_minute')}>`, managed.per_user_per_minute ? lockedHint : 'Prevents repeated clicks or UI loops from running up requests.')}
      ${inputRow('Household requests / day', `<input class="input" type="number" name="household_per_day" min="1" max="100000" required value="${esc(config.household_per_day)}"${lock('household_per_day')}>`, managed.household_per_day ? lockedHint : 'A hard daily safeguard for all household members combined.')}
    </div>
    ${inputRow('Search radius in meters', `<input class="input" type="number" name="radius_meters" min="1" max="50000" required value="${esc(config.radius_meters)}"${lock('radius_meters')}>`, managed.radius_meters ? lockedHint : 'Used only when the selected origin has coordinates; maximum 50,000 meters.')}
    ${config.stored_api_key_configured && !managed.api_key ? '<label class="automation-check-row"><input type="checkbox" name="clear_api_key"> Remove the saved API key</label>' : ''}
    <div class="form-error" role="alert" data-google-places-error hidden></div>
    ${footer}
  </form>`);

  container.querySelector('[data-google-places-config]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = {
      integration_enabled: managed.integration_enabled ? config.integration_enabled : data.has('integration_enabled'),
      terms_accepted: managed.terms_accepted ? config.terms_accepted : data.has('terms_accepted'),
      per_user_per_minute: managed.per_user_per_minute ? config.per_user_per_minute : Number(data.get('per_user_per_minute')),
      household_per_day: managed.household_per_day ? config.household_per_day : Number(data.get('household_per_day')),
      radius_meters: managed.radius_meters ? config.radius_meters : Number(data.get('radius_meters')),
      clear_api_key: !managed.api_key && data.has('clear_api_key'),
    };
    const apiKey = String(data.get('api_key') || '').trim();
    if (!managed.api_key && apiKey) payload.api_key = apiKey;

    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    showError(container, '');
    try {
      const saved = (await api.put('/planning/admin/place-search-config', payload)).data;
      window.yuvomi?.showToast?.(saved.configured
        ? 'Google Places search is ready.'
        : 'Google settings saved. Complete the remaining setup to enable search.');
      if (onSaved) await onSaved(saved);
      else await renderGooglePlacesSettings(container, { modal, onSaved });
    } catch (error) {
      showError(container, error.message || 'Could not save Google Places settings.');
      submit.disabled = false;
    }
  });
}
