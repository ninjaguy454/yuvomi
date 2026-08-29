import { api } from '/api.js';
import { renderPlacesManager } from '/components/activity-automation.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

function mapsUrl(place) {
  const params = new URLSearchParams({ api: '1' });
  if (place?.external_place_id) {
    params.set('query', place.name || 'Google Maps place');
    params.set('query_place_id', place.external_place_id);
  } else if (place?.latitude != null && place?.longitude != null) {
    params.set('query', `${place.latitude},${place.longitude}`);
  } else {
    const address = [place?.street_address, place?.city, place?.region, place?.postal_code, place?.country]
      .filter(Boolean).join(', ');
    if (!address) return null;
    params.set('query', address);
  }
  return `https://www.google.com/maps/search/?${params.toString()}`;
}

async function renderReadOnlyAddressBook(host) {
  const response = await api.get('/planning/places?active=false');
  const places = response.data || [];
  host.insertAdjacentHTML('beforeend', `
    <div class="automation-manager__header"><strong>Places address book</strong></div>
    <p class="form-hint automation-manager__hint">Household administrators can add, search, and edit reusable Places. Everyone can view saved destinations and open them in Google Maps.</p>
    <div class="automation-list">${places.map((place) => {
      const destination = mapsUrl(place);
      return `<div class="list-row automation-list-row">
        <div class="automation-list-row__copy"><strong>${esc(place.path_label || place.name)}</strong><br><small class="form-hint">${esc(place.type)}${place.city ? ` · ${esc(place.city)}` : ''}${place.active ? '' : ' · inactive'}</small></div>
        <div class="automation-list-row__actions">${destination ? `<a class="btn btn--ghost btn--sm" href="${esc(destination)}" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>` : ''}</div>
      </div>`;
    }).join('') || '<p class="form-hint">No Places have been saved yet.</p>'}</div>`);
}

export async function render(container, { user } = {}) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="places-page page-measure--narrow">
      <div class="page-toolbar page-toolbar--wrap page-toolbar--narrow">
        <h1 class="page-toolbar__title">${esc(t('nav.places'))}</h1>
      </div>
      <section class="settings-card settings-card--automation" id="places-address-book"></section>
    </div>`);

  const host = container.querySelector('#places-address-book');
  if (user?.role !== 'admin') {
    await renderReadOnlyAddressBook(host);
    return;
  }

  const manager = {
    navigate: async () => renderPlacesManager(host, manager),
  };
  await renderPlacesManager(host, manager);
  if (window.lucide) window.lucide.createIcons({ el: host });
}
