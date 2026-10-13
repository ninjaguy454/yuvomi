import { api } from '/api.js';
import { esc } from '/utils/html.js';

// Shared by New Task and Trip. Searches run only on an explicit button press.
export function renderPlaceSearch({ prefix = 'task', places = [], status = {}, useLabel = 'Use for Task', allowSave = false } = {}) {
  const origin = places.find(place => place.active !== 0 && place.type === 'home') || places.find(place => place.active !== 0);
  const options = places.filter(place => place.active !== 0).map(place => `<option value="${place.id}" ${Number(place.id) === Number(origin?.id) ? 'selected' : ''}>${esc(place.path_label || place.name)}</option>`).join('');
  const configured = Boolean(status.configured);
  return `<div data-place-search-root data-place-search-prefix="${esc(prefix)}">
    <p class="task-field-hint"><strong>Privacy:</strong> your search text and selected origin are sent to Google through this Vidamia server. Search runs only when you press Search.</p>
    <div class="modal-grid modal-grid--2"><input class="input" id="${prefix}-place-query" minlength="3" maxlength="120" placeholder="UPS Store, pharmacy, dentist…" aria-label="Search places"><select class="input" id="${prefix}-place-category" aria-label="Place type"><option value="">Any type</option><option value="pharmacy">Pharmacy</option><option value="restaurant">Restaurant</option><option value="dentist">Dentist</option><option value="lodging">Hotel / lodging</option><option value="store">Store</option></select></div>
    <select class="input" id="${prefix}-place-origin-mode" aria-label="Search origin" style="margin-top:var(--space-2)"><option value="saved">Near a saved Place</option><option value="text">Near an address, city, or ZIP</option><option value="anywhere">No specific origin</option></select>
    <div data-origin-pane="saved" style="margin-top:var(--space-2)"><select class="input" id="${prefix}-place-origin" aria-label="Saved search origin"><option value="">Choose search origin</option>${options}</select></div>
    <div data-origin-pane="text" style="margin-top:var(--space-2)" hidden><input class="input" id="${prefix}-origin-text" maxlength="160" placeholder="Address, city, or ZIP (for example, 27513)" aria-label="Address, city, or ZIP"></div>
    <div data-origin-pane="anywhere" hidden></div>
    <button class="btn btn--secondary btn--sm" type="button" id="${prefix}-place-search" style="margin-top:var(--space-2)" ${configured ? '' : 'disabled'}>Search Google Places</button>
    <p class="task-field-hint" id="${prefix}-place-search-status" role="status" aria-live="polite">${configured ? `${status.usage?.household_today ?? 0} of ${status.limits?.household_per_day ?? 100} household searches used today.` : 'Google place search is off. An administrator must configure GOOGLE_MAPS_API_KEY, enable the integration, and accept the Google Maps terms. You can still save ordinary addresses.'}</p>
    <div id="${prefix}-place-results" class="automation-list" style="margin-top:var(--space-2)" data-use-label="${esc(useLabel)}" data-allow-save="${allowSave}"></div>
  </div>`;
}

function attribution(result) {
  const thirdParty = (result.attributions || []).map(item => {
    const name = item?.displayName || item?.provider || item?.name;
    const uri = item?.uri || item?.providerUri;
    if (!name) return '';
    return typeof uri === 'string' && /^https:\/\//i.test(uri)
      ? `<a href="${esc(uri)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>` : esc(name);
  }).filter(Boolean);
  return `<small class="form-hint">Results from Google Maps${thirdParty.length ? ` · Attribution: ${thirdParty.join(', ')}` : ''}</small>`;
}

export function bindPlaceSearch(panel, { onUse, onSaved, places = [] } = {}) {
  const root = panel.querySelector('[data-place-search-root]');
  if (!root) return;
  const prefix = root.dataset.placeSearchPrefix;
  const field = suffix => root.querySelector(`#${prefix}-${suffix}`);
  const mode = field('place-origin-mode'), search = field('place-search'), status = field('place-search-status'), list = field('place-results');
  const refresh = () => root.querySelectorAll('[data-origin-pane]').forEach(pane => { pane.hidden = pane.dataset.originPane !== mode.value; });
  mode.addEventListener('change', refresh); refresh();
  let searching = false, selecting = false;
  search.addEventListener('click', async () => {
    if (searching || selecting || search.disabled) return;
    const query = field('place-query').value.trim();
    if (query.length < 3) { status.textContent = 'Enter at least three characters.'; return; }
    const payload = { query, included_type: field('place-category').value || null };
    if (mode.value === 'saved') payload.origin_place_id = Number(field('place-origin').value) || null;
    else if (mode.value === 'text') payload.origin_text = field('origin-text').value.trim() || null;
    searching = true; search.disabled = true; status.textContent = 'Searching Google Places…';
    list.replaceChildren();
    try {
      const results = (await api.post('/planning/place-search', payload)).data || [];
      if (!root.isConnected) return;
      status.textContent = results.length ? `${results.length} live result${results.length === 1 ? '' : 's'} from Google.` : 'No matching places found.';
      results.forEach((result, index) => {
        const row = document.createElement('div'); row.className = 'list-row automation-list-row';
        const distance = result.distance_meters == null ? '' : ` · ${(result.distance_meters / 1609.344).toFixed(1)} mi`;
        row.insertAdjacentHTML('beforeend', `<div class="automation-list-row__copy"><strong>${esc(result.display_name)}</strong><br><small class="form-hint">${esc(result.formatted_address || '')}${esc(distance)}${result.primary_type ? ` · ${esc(result.primary_type)}` : ''}</small><br>${attribution(result)}<input class="input" data-place-save-name="${index}" maxlength="120" value="${esc(result.display_name)}" aria-label="Vidamia Place name"></div><div class="automation-list-row__actions"><button type="button" class="btn btn--primary btn--sm" data-use-place="${index}">${esc(list.dataset.useLabel)}</button>${list.dataset.allowSave === 'true' ? `<button type="button" class="btn btn--secondary btn--sm" data-save-place="${index}">Save to Places</button>` : ''}</div>`);
        list.appendChild(row);
      });
      const action = (button, callback) => button.addEventListener('click', async () => {
        if (selecting || searching || button.disabled) return;
        const index = Number(button.dataset.usePlace ?? button.dataset.savePlace), result = results[index];
        const name = list.querySelector(`[data-place-save-name="${index}"]`).value.trim();
        selecting = true; const buttons = [...list.querySelectorAll('button')]; buttons.forEach(item => { item.disabled = true; }); search.disabled = true;
        try { await callback(result, name); }
        catch (error) { if (root.isConnected) status.textContent = error.message; }
        finally { selecting = false; if (root.isConnected) { buttons.forEach(item => { item.disabled = false; }); search.disabled = false; } }
      });
      list.querySelectorAll('[data-use-place]').forEach(button => action(button, onUse));
      list.querySelectorAll('[data-save-place]').forEach(button => action(button, async (result, name) => {
        if (!name) throw Error('Give the saved Vidamia Place a name.');
        const saved = await saveSearchPlace(result, name, places);
        if (!root.isConnected) return;
        await onSaved?.(saved); status.textContent = 'Saved to Vidamia Places and selected for this Task.';
      }));
    } catch (error) { if (root.isConnected) status.textContent = error.message; }
    finally { searching = false; if (root.isConnected) search.disabled = false; }
  });
}

export async function saveSearchPlace(result, name, places = []) {
  const existing = places.find(place => place.external_provider === 'google' && place.external_place_id === result.external_place_id);
  if (existing) {
    if (existing.active === 0) throw Error('That Place is inactive. Choose an active Place or update it in Address Book.');
    return existing;
  }
  try {
    return (await api.post('/planning/admin/places/from-google', {external_place_id:result.external_place_id,name,type:'custom',latitude:result.latitude,longitude:result.longitude})).data;
  } catch (error) {
    const saved = error.status === 409 ? error.data?.data : null;
    if (saved?.id && saved.active !== 0) return saved;
    throw error;
  }
}
