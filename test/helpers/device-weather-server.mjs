// Actual app with deterministic providers; never contact a Weather service.
const actualFetch = globalThis.fetch;
const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
globalThis.fetch = async (url, options) => {
  const parsed = new URL(url);
  if (['127.0.0.1', 'localhost'].includes(parsed.hostname)) return actualFetch(url, options);
  if (parsed.hostname === 'api.open-meteo.com') return { ok: true, json: async () => ({
    current: { temperature_2m: 68, apparent_temperature: 67, relative_humidity_2m: 50, is_day: 1, weather_code: 2, wind_speed_10m: 4 },
    daily: { time: [0,1,2,3,4,5].map(day), weather_code: [2,0,3,61,2,0], temperature_2m_max: [72,74,68,65,70,73], temperature_2m_min: [55,56,50,51,53,56] },
  }) };
  if (parsed.hostname === 'api.openweathermap.org') return { ok: true, json: async () => parsed.pathname.endsWith('/forecast')
    ? { list: [1,2,3,4,5].map(i => ({ dt_txt: `${day(i)} 12:00:00`, main: { temp: 70 }, weather: [{ icon: '10d', description: 'Light rain' }] })) }
    : { name: 'Synthetic Household Town', main: { temp: 68, feels_like: 67, humidity: 50 }, weather: [{ icon: '01d', description: 'Clear sky' }], wind: { speed: 4 } } };
  throw Error('Synthetic Weather fixture blocked external fetch');
};
await import('./note-board-full-app-server.mjs');
