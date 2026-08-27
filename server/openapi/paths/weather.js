import { op } from '../helpers.js';

export function weatherPaths() {
  return {
    '/api/v1/weather': { get: op({ summary: 'Get weather data', tag: 'Weather', description: 'Returns `{ data: { provider, city, units, current, today, forecast } }` or `{ data: null }` when no provider is configured. `today` carries the calendar day at the weather location plus its high/low; `forecast` holds the following days only. `provider` is `open-meteo` (icon fields are Lucide icon names, `desc` is a `wmo.<code>` i18n key) or `openweathermap` (legacy; icon fields are OWM icon codes, `desc` is localized text).' }) },
    '/api/v1/weather/icon/{code}': {
      get: op({ summary: 'Get weather icon asset', tag: 'Weather', params: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }] }),
    },
  };
}
