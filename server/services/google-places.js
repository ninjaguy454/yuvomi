const PROVIDER = 'google';
const OPERATION = 'text_search';
const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.attributions';

const inFlightUsers = new Set();
const minuteWindows = new Map();

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

export function googlePlacesConfig() {
  return {
    configured: Boolean(String(process.env.GOOGLE_PLACES_API_KEY || '').trim()),
    perUserPerMinute: positiveInteger(process.env.GOOGLE_PLACES_PER_USER_PER_MINUTE, 10, { max: 120 }),
    householdPerDay: positiveInteger(process.env.GOOGLE_PLACES_PER_HOUSEHOLD_PER_DAY, 100),
    radiusMeters: positiveInteger(process.env.GOOGLE_PLACES_SEARCH_RADIUS_METERS, 50000, { max: 50000 }),
    timeoutMs: positiveInteger(process.env.GOOGLE_PLACES_TIMEOUT_MS, 8000, { min: 1000, max: 30000 }),
  };
}

export function googlePlacesStatus() {
  const config = googlePlacesConfig();
  return {
    provider: PROVIDER,
    configured: config.configured,
    search_mode: 'deliberate_text_search',
    result_limit: 10,
    limits: {
      per_user_per_minute: config.perUserPerMinute,
      household_per_day: config.householdPerDay,
    },
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

function takeDailySlot(database, userId, limit, now) {
  const used = database.prepare(`
    SELECT COALESCE(SUM(request_count), 0) AS count
      FROM place_provider_usage
     WHERE usage_date = ? AND provider = ? AND operation = ?
  `).get(dateKey(now), PROVIDER, OPERATION).count;
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
  `).run(dateKey(now), PROVIDER, OPERATION, userId);
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

export async function searchGooglePlaces(database, {
  userId,
  query,
  origin,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const config = googlePlacesConfig();
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
  const normalizedQuery = cleanText(query, 'Search', 120);
  if (normalizedQuery.length < 2) {
    throw new PlaceProviderError('Search must contain at least two characters.', { code: 'invalid_search' });
  }
  const latitude = coordinate(origin?.latitude, -90, 90, 'Origin latitude');
  const longitude = coordinate(origin?.longitude, -180, 180, 'Origin longitude');

  if (inFlightUsers.has(normalizedUserId)) {
    throw new PlaceProviderError('A Place search is already running for this user.', {
      status: 429,
      code: 'place_search_in_flight',
    });
  }
  takeMinuteSlot(normalizedUserId, config.perUserPerMinute, now);
  takeDailySlot(database, normalizedUserId, config.householdPerDay, now);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  inFlightUsers.add(normalizedUserId);
  try {
    const response = await fetchImpl(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': String(process.env.GOOGLE_PLACES_API_KEY).trim(),
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: normalizedQuery,
        pageSize: 10,
        rankPreference: 'DISTANCE',
        locationBias: {
          circle: {
            center: { latitude, longitude },
            radius: config.radiusMeters,
          },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new PlaceProviderError('Google Places could not complete the search.', {
        status: response.status === 429 ? 429 : 502,
        code: response.status === 429 ? 'place_provider_rate_limited' : 'place_provider_failed',
      });
    }
    const payload = await response.json();
    return (payload.places || []).map(normalizeResult).filter(Boolean).slice(0, 10);
  } catch (error) {
    if (error instanceof PlaceProviderError) throw error;
    if (error?.name === 'AbortError') {
      throw new PlaceProviderError('Google Places took too long to respond.', {
        status: 504,
        code: 'place_provider_timeout',
      });
    }
    throw new PlaceProviderError('Google Places is temporarily unavailable.', {
      status: 502,
      code: 'place_provider_unavailable',
    });
  } finally {
    clearTimeout(timeout);
    inFlightUsers.delete(normalizedUserId);
  }
}

export function _resetGooglePlacesLimitsForTests() {
  inFlightUsers.clear();
  minuteWindows.clear();
}

export const GOOGLE_PLACES_FIELD_MASK = FIELD_MASK;

