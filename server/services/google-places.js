const PROVIDER = 'google';
const OPERATION = 'text_search';
const REFRESH_OPERATION = 'id_refresh';
const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.attributions';
const DETAILS_URL = 'https://places.googleapis.com/v1/places/';
const INCLUDED_TYPES = new Set(['pharmacy', 'restaurant', 'dentist', 'lodging', 'store', 'hotel']);
const CONFIG_KEYS = Object.freeze({
  apiKey: 'google_maps_api_key',
  integrationEnabled: 'google_maps_enabled',
  termsAccepted: 'google_maps_terms_accepted',
  perUserPerMinute: 'google_places_per_user_per_minute',
  householdPerDay: 'google_places_per_household_per_day',
  radiusMeters: 'google_places_search_radius_meters',
});

const inFlightUsers = new Set();
const identicalInFlight = new Map();
const minuteWindows = new Map();
let failureCount = 0;
let circuitOpenUntil = 0;

export class PlaceProviderError extends Error {
  constructor(message, { status = 400, code = 'place_provider_error' } = {}) {
    super(message);
    this.name = 'PlaceProviderError';
    this.status = status;
    this.code = code;
  }
}

function positiveInteger(value, fallback, { min = 1, max = 100000 } = {}) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function storedValue(database, key) {
  if (!database) return null;
  return database.prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value ?? null;
}

function storeValue(database, key, value) {
  database.prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(key, String(value));
}

function deleteStoredValue(database, key) {
  database.prepare('DELETE FROM sync_config WHERE key = ?').run(key);
}

function envSetting(...names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(process.env, name)
        && String(process.env[name] ?? '').trim() !== '') {
      return { managed: true, value: process.env[name] };
    }
  }
  return { managed: false, value: null };
}

function configuredValue(database, key, environment, fallback = null) {
  return environment.managed ? environment.value : (storedValue(database, key) ?? fallback);
}

export function googlePlacesConfig(database = null) {
  const apiKeyEnv = envSetting('GOOGLE_MAPS_API_KEY', 'GOOGLE_PLACES_API_KEY');
  const enabledEnv = envSetting('GOOGLE_MAPS_ENABLED');
  const termsEnv = envSetting('GOOGLE_MAPS_TERMS_ACCEPTED');
  const perUserEnv = envSetting('GOOGLE_PLACES_PER_USER_PER_MINUTE');
  const householdEnv = envSetting('GOOGLE_PLACES_PER_HOUSEHOLD_PER_DAY');
  const radiusEnv = envSetting('GOOGLE_PLACES_SEARCH_RADIUS_METERS');
  const apiKey = String(configuredValue(database, CONFIG_KEYS.apiKey, apiKeyEnv, '') || '').trim();
  const integrationEnabled = enabled(configuredValue(database, CONFIG_KEYS.integrationEnabled, enabledEnv, 'false'));
  const termsAccepted = enabled(configuredValue(database, CONFIG_KEYS.termsAccepted, termsEnv, 'false'));
  return {
    apiKey,
    integrationEnabled,
    termsAccepted,
    configured: Boolean(apiKey) && integrationEnabled && termsAccepted,
    perUserPerMinute: positiveInteger(configuredValue(database, CONFIG_KEYS.perUserPerMinute, perUserEnv), 10, { max: 120 }),
    householdPerDay: positiveInteger(configuredValue(database, CONFIG_KEYS.householdPerDay, householdEnv), 100),
    radiusMeters: positiveInteger(configuredValue(database, CONFIG_KEYS.radiusMeters, radiusEnv), 50000, { max: 50000 }),
    timeoutMs: positiveInteger(process.env.GOOGLE_PLACES_TIMEOUT_MS, 8000, { min: 1000, max: 30000 }),
    managedByEnvironment: {
      api_key: apiKeyEnv.managed,
      integration_enabled: enabledEnv.managed,
      terms_accepted: termsEnv.managed,
      per_user_per_minute: perUserEnv.managed,
      household_per_day: householdEnv.managed,
      radius_meters: radiusEnv.managed,
    },
  };
}

export function googlePlacesAdminConfig(database) {
  const config = googlePlacesConfig(database);
  return {
    provider: PROVIDER,
    configured: config.configured,
    api_key_configured: Boolean(config.apiKey),
    stored_api_key_configured: Boolean(String(storedValue(database, CONFIG_KEYS.apiKey) || '').trim()),
    api_key_source: config.managedByEnvironment.api_key ? 'environment' : (config.apiKey ? 'settings' : 'none'),
    integration_enabled: config.integrationEnabled,
    terms_accepted: config.termsAccepted,
    per_user_per_minute: config.perUserPerMinute,
    household_per_day: config.householdPerDay,
    radius_meters: config.radiusMeters,
    managed_by_environment: config.managedByEnvironment,
  };
}

function requiredInteger(value, field, { min = 1, max = 100000 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new PlaceProviderError(`${field} must be a whole number from ${min} to ${max}.`, {
      status: 400,
      code: 'invalid_place_provider_config',
    });
  }
  return parsed;
}

export function saveGooglePlacesAdminConfig(database, input = {}) {
  if (!database || !input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PlaceProviderError('Google Places settings are invalid.', {
      status: 400,
      code: 'invalid_place_provider_config',
    });
  }
  const apiKey = String(input.api_key || '').trim();
  if (apiKey.length > 500) {
    throw new PlaceProviderError('The Google Maps API key is too long.', {
      status: 400,
      code: 'invalid_place_provider_config',
    });
  }
  const values = {
    integrationEnabled: input.integration_enabled === true ? 'true' : 'false',
    termsAccepted: input.terms_accepted === true ? 'true' : 'false',
    perUserPerMinute: requiredInteger(input.per_user_per_minute, 'Per-user request limit', { max: 120 }),
    householdPerDay: requiredInteger(input.household_per_day, 'Household daily request limit'),
    radiusMeters: requiredInteger(input.radius_meters, 'Search radius', { max: 50000 }),
  };
  database.transaction(() => {
    if (input.clear_api_key === true) deleteStoredValue(database, CONFIG_KEYS.apiKey);
    else if (apiKey) storeValue(database, CONFIG_KEYS.apiKey, apiKey);
    storeValue(database, CONFIG_KEYS.integrationEnabled, values.integrationEnabled);
    storeValue(database, CONFIG_KEYS.termsAccepted, values.termsAccepted);
    storeValue(database, CONFIG_KEYS.perUserPerMinute, values.perUserPerMinute);
    storeValue(database, CONFIG_KEYS.householdPerDay, values.householdPerDay);
    storeValue(database, CONFIG_KEYS.radiusMeters, values.radiusMeters);
  })();
  return googlePlacesAdminConfig(database);
}

export function googlePlacesStatus(database = null, userId = null, now = new Date()) {
  const config = googlePlacesConfig(database);
  const householdUsed = database ? Number(database.prepare(`SELECT COALESCE(SUM(request_count), 0) AS n FROM place_provider_usage WHERE usage_date = ? AND provider = 'google'`).get(dateKey(now)).n) : null;
  const userUsed = database && userId ? Number(database.prepare(`SELECT COALESCE(SUM(request_count), 0) AS n FROM place_provider_usage WHERE usage_date = ? AND provider = 'google' AND user_id = ?`).get(dateKey(now), userId).n) : null;
  return {
    provider: PROVIDER,
    configured: config.configured,
    setup: {
      api_key_configured: Boolean(config.apiKey),
      integration_enabled: config.integrationEnabled,
      terms_accepted: config.termsAccepted,
    },
    search_mode: 'deliberate_text_search',
    result_limit: 10,
    limits: {
      per_user_per_minute: config.perUserPerMinute,
      household_per_day: config.householdPerDay,
    },
    usage: { household_today: householdUsed, user_today: userUsed },
    privacy_notice: 'Search terms and the selected origin are sent to Google Places through this Yuvomi server.',
  };
}

function cleanText(value, field, max) {
  const result = value == null ? '' : String(value).trim();
  if (!result) throw new PlaceProviderError(`${field} is required.`, { code: 'invalid_search' });
  if (result.length > max) throw new PlaceProviderError(`${field} is too long.`, { code: 'invalid_search' });
  return result;
}

function coordinate(value, min, max, field) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new PlaceProviderError(`${field} is invalid.`, { code: 'invalid_origin' });
  }
  return result;
}

function dateKey(now) {
  return now.toISOString().slice(0, 10);
}

function takeMinuteSlot(userId, limit, now) {
  const key = String(userId);
  const start = now.getTime() - 60_000;
  const recent = (minuteWindows.get(key) || []).filter((timestamp) => timestamp > start);
  if (recent.length >= limit) {
    minuteWindows.set(key, recent);
    throw new PlaceProviderError('Place search is temporarily limited. Try again in a minute.', {
      status: 429,
      code: 'place_search_rate_limited',
    });
  }
  recent.push(now.getTime());
  minuteWindows.set(key, recent);
}

function takeDailySlot(database, userId, limit, now, operation = OPERATION) {
  const used = database.prepare(`
    SELECT COALESCE(SUM(request_count), 0) AS count
      FROM place_provider_usage
     WHERE usage_date = ? AND provider = ?
  `).get(dateKey(now), PROVIDER).count;
  if (Number(used) >= limit) {
    throw new PlaceProviderError('The household Place-search limit has been reached for today.', {
      status: 429,
      code: 'place_search_daily_limit',
    });
  }
  database.prepare(`
    INSERT INTO place_provider_usage (usage_date, provider, operation, user_id, request_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(usage_date, provider, operation, user_id) DO UPDATE SET
      request_count = request_count + 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(dateKey(now), PROVIDER, operation, userId);
}

function noteProviderFailure() {
  failureCount += 1;
  if (failureCount >= 3) circuitOpenUntil = Date.now() + 60_000;
}

function normalizeResult(place) {
  if (!place?.id) return null;
  return {
    provider: PROVIDER,
    external_place_id: String(place.id),
    display_name: String(place.displayName?.text || '').trim() || 'Google Maps place',
    formatted_address: String(place.formattedAddress || '').trim() || null,
    latitude: Number.isFinite(Number(place.location?.latitude)) ? Number(place.location.latitude) : null,
    longitude: Number.isFinite(Number(place.location?.longitude)) ? Number(place.location.longitude) : null,
    primary_type: place.primaryType || null,
    attributions: Array.isArray(place.attributions) ? place.attributions : [],
  };
}

function distanceMeters(a, b) {
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
}

export async function searchGooglePlaces(database, {
  userId,
  query,
  origin,
  includedType = null,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const config = googlePlacesConfig(database);
  if (!config.configured) {
    throw new PlaceProviderError('Google Places is not configured for this Yuvomi instance.', {
      status: 503,
      code: 'place_provider_not_configured',
    });
  }
  const normalizedUserId = Number(userId);
  if (!Number.isInteger(normalizedUserId) || normalizedUserId < 1) {
    throw new PlaceProviderError('A signed-in user is required.', { status: 401, code: 'authentication_required' });
  }
  // The route may add a human-readable origin (for example "near 27513") to
  // the user's deliberately submitted query. This avoids a second geocoding
  // request and lets Text Search resolve an address, city, or ZIP itself.
  const normalizedQuery = cleanText(query, 'Search', 300);
  if (normalizedQuery.length < 3) {
    throw new PlaceProviderError('Search must contain at least three characters.', { code: 'invalid_search' });
  }
  const hasCoordinateOrigin = origin?.latitude !== undefined && origin?.latitude !== null && origin?.latitude !== ''
    && origin?.longitude !== undefined && origin?.longitude !== null && origin?.longitude !== '';
  const latitude = hasCoordinateOrigin ? coordinate(origin.latitude, -90, 90, 'Origin latitude') : null;
  const longitude = hasCoordinateOrigin ? coordinate(origin.longitude, -180, 180, 'Origin longitude') : null;

  const normalizedType = includedType && INCLUDED_TYPES.has(String(includedType)) ? String(includedType) : null;
  const requestKey = JSON.stringify([normalizedUserId, normalizedQuery.toLowerCase(), latitude, longitude, normalizedType]);
  if (identicalInFlight.has(requestKey)) return identicalInFlight.get(requestKey);
  if (Date.now() < circuitOpenUntil) {
    throw new PlaceProviderError('Google Places is temporarily paused after repeated provider errors. Try again shortly.', { status: 503, code: 'place_provider_circuit_open' });
  }
  if (inFlightUsers.has(normalizedUserId)) {
    throw new PlaceProviderError('A Place search is already running for this user.', {
      status: 429,
      code: 'place_search_in_flight',
    });
  }
  takeMinuteSlot(normalizedUserId, config.perUserPerMinute, now);
  takeDailySlot(database, normalizedUserId, config.householdPerDay, now);

  const operation = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    inFlightUsers.add(normalizedUserId);
    try {
    const response = await fetchImpl(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: normalizedQuery,
        pageSize: 10,
        ...(hasCoordinateOrigin ? {
          rankPreference: 'DISTANCE',
          locationBias: {
          circle: {
            center: { latitude, longitude },
            radius: config.radiusMeters,
          },
          },
        } : {}),
        ...(normalizedType ? { includedType: normalizedType, strictTypeFiltering: false } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      noteProviderFailure();
      throw new PlaceProviderError('Google Places could not complete the search.', {
        status: response.status === 429 ? 429 : 502,
        code: response.status === 429 ? 'place_provider_rate_limited' : 'place_provider_failed',
      });
    }
    const payload = await response.json();
    failureCount = 0;
    return (payload.places || []).map(normalizeResult).filter(Boolean).slice(0, 10).map((place) => ({
      ...place,
      distance_meters: hasCoordinateOrigin && place.latitude != null && place.longitude != null
        ? distanceMeters({ latitude, longitude }, place) : null,
    }));
  } catch (error) {
    if (error instanceof PlaceProviderError) throw error;
    if (error?.name === 'AbortError') {
      noteProviderFailure();
      throw new PlaceProviderError('Google Places took too long to respond.', {
        status: 504,
        code: 'place_provider_timeout',
      });
    }
    noteProviderFailure();
    throw new PlaceProviderError('Google Places is temporarily unavailable.', {
      status: 502,
      code: 'place_provider_unavailable',
    });
  } finally {
    clearTimeout(timeout);
    inFlightUsers.delete(normalizedUserId);
  }
  })();
  identicalInFlight.set(requestKey, operation);
  try { return await operation; }
  finally { identicalInFlight.delete(requestKey); }
}

export async function refreshGooglePlaceId(placeId, {
  database = null,
  userId = null,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const config = googlePlacesConfig(database);
  if (!config.configured) throw new PlaceProviderError('Google Places is not configured.', { status: 503, code: 'place_provider_not_configured' });
  if (Date.now() < circuitOpenUntil) {
    throw new PlaceProviderError('Google Places is temporarily paused after repeated provider errors. Try again shortly.', { status: 503, code: 'place_provider_circuit_open' });
  }
  const clean = cleanText(placeId, 'Place ID', 250);
  if (database && userId) takeDailySlot(database, Number(userId), config.householdPerDay, now, REFRESH_OPERATION);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${DETAILS_URL}${encodeURIComponent(clean)}`, {
      headers: { 'X-Goog-Api-Key': config.apiKey, 'X-Goog-FieldMask': 'id,movedPlaceId' },
      signal: controller.signal,
    });
    if (!response.ok) {
      noteProviderFailure();
      throw new PlaceProviderError('Google could not refresh this Place ID.', {
        status: response.status === 429 ? 429 : 502,
        code: response.status === 429 ? 'place_provider_rate_limited' : 'place_id_refresh_failed',
      });
    }
    const payload = await response.json();
    failureCount = 0;
    return String(payload.movedPlaceId || payload.id || clean);
  } catch (error) {
    if (error instanceof PlaceProviderError) throw error;
    noteProviderFailure();
    if (error?.name === 'AbortError') {
      throw new PlaceProviderError('Google Places took too long to respond.', { status: 504, code: 'place_provider_timeout' });
    }
    throw new PlaceProviderError('Google Places is temporarily unavailable.', { status: 502, code: 'place_provider_unavailable' });
  } finally {
    clearTimeout(timeout);
  }
}

export const GooglePlaceSearchProvider = Object.freeze({
  provider: PROVIDER,
  searchText: searchGooglePlaces,
  getPlace: refreshGooglePlaceId,
  refreshExternalId: refreshGooglePlaceId,
  navigationUrl(placeId, label = 'Google Maps place') {
    const params = new URLSearchParams({ api: '1', query: label, query_place_id: placeId });
    return `https://www.google.com/maps/search/?${params.toString()}`;
  },
});

export function _resetGooglePlacesLimitsForTests() {
  inFlightUsers.clear();
  identicalInFlight.clear();
  minuteWindows.clear();
  failureCount = 0;
  circuitOpenUntil = 0;
}

export const GOOGLE_PLACES_FIELD_MASK = FIELD_MASK;
