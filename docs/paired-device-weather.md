# Household Weather on paired devices

Weather is the existing Overview widget, not a standalone navigation module.
Paired devices previously rejected `/api/v1/weather`, excluded Weather from
device widget configuration, and fixed its widget permission to `none` even
when an administrator supplied `allow`.

The paired-device adapter now admits only `GET /api/v1/weather`. It requires
Dashboard read access and explicit `permissions.widgets.weather: "allow"`.
An invisible Weather widget returns `{data:null}`, preventing the normal
Overview masthead from showing a hidden forecast. Missing or denied permission
remains denied. New devices also start with Weather denied and hidden.

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
