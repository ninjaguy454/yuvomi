# Household Weather on paired devices

Weather is the existing Overview widget, not a standalone navigation module.
Paired devices previously rejected `/api/v1/weather`, excluded Weather from
device widget configuration, and fixed its widget permission to `none` even
when an administrator supplied `allow`.

The paired-device adapter admits `GET /api/v1/weather` and the exact appearance
reads `GET /api/v1/weather/theme` and `GET /api/v1/weather/scene`. They require
Dashboard read access and explicit `permissions.widgets.weather: "allow"`.
An invisible Weather widget returns `{data:null}`, preventing the normal
Overview masthead from showing a hidden forecast. Missing or denied permission
remains denied. New devices also start with Weather denied and hidden.

The appearance reads use the same Dashboard and Weather grants independently
of widget visibility. `/theme` retains its seven-field coarse observation.
`/scene` returns `{data:{theme,scene}}` or `{data:null}`; valid coarse weather
with unavailable or invalid richer facts returns `scene:null`. Wall uses
`/api/v1/wall/weather/scene` with its existing browser-session and module gates.
Both adapters check access again after the provider await. Scene responses are
private and `no-store`, and neither endpoint enables a grant or personal
location override.

Scene v1 contains only provider, matching observation/fetch/expiry timestamps,
numeric condition code, up to four supported phenomena, precipitation, wind,
cloud cover, visibility, and solar facts. Every object has an explicit field
whitelist, and scene JSON is bounded to 4 KiB. Unsupported codes and expired
facts are rejected. Wind is metres/second with meteorological from-direction;
unknown optional values remain null and a reported gust below mean wind is
retained. Visibility is bounded to 100,000 metres. Solar uses the companion
theme's valid ordered sunrise/sunset pair or paired null values.

One provider response and cache entry serves legacy and scene readers, retaining
the 30-minute TTL, 90-minute freshness limit, 50-entry bound, in-flight
deduplication, local-day rollover and 60-second failure cache. Open-Meteo current
rain and showers are summed only when both values and their units are known;
snowfall centimetres remain separate from liquid millimetres. Its supplied
`current.interval` is retained in seconds rather than converted into an hourly
rate. OpenWeatherMap `rain.1h` and `snow.1h` retain their 3,600-second interval;
snow is stored as water-equivalent millimetres, never snowfall centimetres.
Positive liquid and snowfall may infer mixture within an interval, while codes
615/616 report mixture directly. Thunder without reported precipitation keeps
an unknown precipitation kind. Frost, blizzard and dry storm are not direct
reported facts.

Provider mappings and units were checked against the official
[Open-Meteo documentation](https://open-meteo.com/en/docs),
[OpenWeatherMap condition table](https://openweathermap.org/api/weather-conditions)
and [current-response documentation](https://openweathermap.org/api/current)
on 2026-10-14. Open-Meteo's current table explicitly supports 97 (heavy
thunderstorm); 96/99 hail is model-dependent. OpenWeatherMap's published current
condition table has no hail ID. Open-Meteo current conditions are model data;
gust timing, illumination and glass residue remain bounded illustrations.

In Household Devices → Configure, **Household Weather** grants access; the
separate **Dashboard widgets → Weather** checkbox controls visibility, order,
and size. Existing configurations without a Weather layout entry offer it
unchecked. A cosmetic save does not enable Weather. Partial Weather updates
merge with existing widget grants; unrelated module and capability behavior is
unchanged.

The adapter reuses the existing household provider, units, and location. It
does not inherit the pairing administrator's personal Weather preferences or
return configuration coordinates, location settings, or provider credentials.
Only a validated language selector reaches the provider; caller location
overrides are discarded. Its cache is separate from personal Weather so a
member's city label cannot cross into the household response. A device context
change while the provider responds rejects the pending response.

Device preferences do not enable geolocation. Temporary personal sign-in keeps
the member's ordinary Weather behavior; returning to the device restores the
household forecast. Legacy OpenWeatherMap conditions use local icons on the
device, preserving the existing authentication boundary for image routes.

No database migration, automatic grant rewrite, location update, credential
creation, or live-device mutation is part of this change. Enabling an existing
device requires an authorized administrator update using its latest revision.

Regression coverage lives in `test/test-device-weather.js` and
`test/test-device-weather-browser.js`, registered in the device test suites.
Provider responses and all users/devices in these tests are synthetic. The
browser suite exercises opt-in/preservation, denied/hidden states, direct
Overview/reload, collapsed navigation, mobile and wall-sized viewports in both
themes, personal sign-in/return, and legacy-provider icons.

Release integration must advance the service-worker cache generation after
combining this candidate with any concurrent release. This branch intentionally
does not reserve a generation while the separate tilt release is underway.
