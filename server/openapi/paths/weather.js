import { op } from '../helpers.js';

export function weatherPaths() {
  return {
    '/api/v1/weather': { get: op({ summary: 'Get weather data', tag: 'Weather', description: 'Returns `{ data: { provider, city, units, current, today, forecast } }` or `{ data: null }` when no provider is configured. `today` carries the calendar day at the weather location plus its high/low; `forecast` holds the following days only. `provider` is `open-meteo` (icon fields are Lucide icon names, `desc` is a `wmo.<code>` i18n key) or `openweathermap` (legacy; icon fields are OWM icon codes, `desc` is localized text).' }) },
    '/api/v1/weather/theme': { get: op({ summary: 'Get coarse household weather for Local Weather appearance', tag: 'Weather', description: 'Requires existing Dashboard read and Weather allow permissions. Returns only condition, is_day, observed_at, fetched_at, expires_at, sunrise_at and sunset_at, or data:null. Uses household configuration; ignores client location and personal overrides. No coordinates, city or credentials are returned.' }) },
    '/api/v1/wall/weather/theme': { get: op({ summary: 'Get coarse household weather for Wall appearance', tag: 'Weather', description: 'Requires a household browser session, Dashboard read and Weather allow permissions. Uses the same minimal household weather projection and cache as /weather/theme.' }) },
    '/api/v1/weather/scene': { get: op({ summary: 'Get household weather scene facts', tag: 'Weather', description: 'Requires existing Dashboard read and Weather allow permissions, also for paired devices. Returns {data:{theme,scene}} or {data:null}; theme is the unchanged seven-field coarse observation. scene is strictly whitelisted v1 provider facts or null when unavailable, unsupported or invalid. Provider timestamps match theme; precipitation retains its reported interval and units are normalized explicitly. Uses household configuration and the shared weather cache, ignores client location and personal overrides, and returns no location, user identity, raw provider body or credentials. Responses are private, no-store.' }) },
    '/api/v1/wall/weather/scene': { get: op({ summary: 'Get household weather scene facts for Wall appearance', tag: 'Weather', description: 'Requires a household browser session, Dashboard read and Weather allow permissions before and after the provider await. Uses the same household {theme,scene} projection and cache as /weather/scene, independently of Weather widget visibility. Responses are private, no-store.' }) },
    '/api/v1/weather/icon/{code}': {
      get: op({ summary: 'Get weather icon asset', tag: 'Weather', params: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }] }),
    },
  };
}
