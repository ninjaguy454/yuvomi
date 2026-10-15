// Actual joined application; only the external provider and clock are synthetic.
const NativeDate = Date;
let fixtureNow = Date.parse(process.env.WEATHER_FIXTURE_NOW || '2026-10-15T01:08:00.000Z');
process.on('message', message => {
  if (message?.type === 'weather-fixture-clock' && Number.isFinite(message.now)) {
    fixtureNow = message.now;
    process.send?.({type:'weather-fixture-clock', now:fixtureNow});
  }
});
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [fixtureNow])); }
  static now() { return fixtureNow; }
};
globalThis.fetch = async url => {
  if (new URL(url).hostname !== 'api.open-meteo.com') throw Error('Unexpected synthetic provider request');
  const local = new NativeDate(fixtureNow - 14400 * 1000).toISOString(), day = local.slice(0,10);
  const rise = NativeDate.parse(day + 'T11:10:00.000Z'), set = NativeDate.parse(day + 'T22:20:00.000Z');
  return { ok: true, json: async () => ({
    utc_offset_seconds: -14400,
    current: { time: local.slice(0,16), interval: 900, is_day: Number(fixtureNow >= rise && fixtureNow < set), weather_code: 0,
      temperature_2m: 14, apparent_temperature: 14, relative_humidity_2m: 50,
      wind_speed_10m: 0, wind_gusts_10m: 0, wind_direction_10m: 270,
      cloud_cover: 0, visibility: 15000, rain: 0, showers: 0, snowfall: 0 },
    current_units: { time: 'iso8601', interval: 'seconds', wind_speed_10m: 'km/h',
      wind_gusts_10m: 'km/h', wind_direction_10m: '°', cloud_cover: '%',
      visibility: 'm', rain: 'mm', showers: 'mm', snowfall: 'cm' },
    daily: { time: [day], weather_code: [0], temperature_2m_max: [20],
      temperature_2m_min: [12], sunrise: [day + 'T07:10'], sunset: [day + 'T18:20'] }
  }) };
};
await import('./note-board-full-app-server.mjs');
