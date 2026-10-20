# Local Weather artwork and scene facts

Local Weather combines the existing readable condition theme with the approved
Crawford Notch artwork and bounded atmospheric/card-rim decoration. The unchanged
manual preview was approved at SHA256
`3fd197cb744870e741ae34722abb1b12ced2fc75e37f17e9b313048344388bff`.

`GET /api/v1/weather/scene` and `GET /api/v1/wall/weather/scene` return
`{data:{theme,scene}}` or `{data:null}`. `theme` retains the existing seven-field
observation. `scene` is an optional v1 projection with strict nested whitelists,
matching timestamps and a4KiB size limit; invalid/unsupported richer facts become
null while a valid coarse theme remains usable. Widget and legacy theme routes
keep their previous response shapes. One provider response/cache serves both.

Scene selection uses household configuration. Client coordinates/city and personal
widget location overrides cannot choose the artwork location. Dashboard/Weather
grants, paired-device validity and Wall authorization are checked through the
existing boundaries before/after provider awaits. No location, user identifier,
credential or raw provider object crosses the scene interface. The client erases
facts/effects/audio on an ending owner and rejects late responses. Scene API reads
are network-only and never enter service-worker/API/durable storage.

Open-Meteo current fields add direction, gusts, cloud cover, visibility and
precipitation amounts to the existing request. Unit validation preserves unknown
optional facts as null, distinguishes snowfall centimetres from snow water
millimetres, and retains the provider interval. Unsupported phenomena do not come
from temperature guesses. OpenWeatherMap retains its compatible optional fields.
Official provider references:
[Open-Meteo](https://open-meteo.com/en/docs),
[OpenWeatherMap conditions](https://openweathermap.org/api/weather-conditions),
[OpenWeatherMap current fields](https://openweathermap.org/api/current).

Solar grading has illustrative twenty-minute dawn/dusk shoulders around valid
reported sunrise/sunset; missing solar pairs use is_day. Meteorological wind is a
from-direction projected onto a fixed painting. Gust timing, cloud illumination,
wetness/ice/snow accumulation and their decay are artwork, not measurements of a
household pane, a blizzard or a strike. Thunder alone does not establish rain or
a confirmed dry storm. No chimney or lights are invented in Cole's inn.

The unchanged night derivative is complemented by a masked deep-blue sky wash
and at most72static illustrative stars selected deterministically from verified
sky-mask pixels. The wash fades with the same solar grade; stars sit beneath
weather clouds, dim with cloud cover, and disappear in overcast, fog, precipitation
and thunderstorms. Stars require known dry clear/partly-cloudy facts; rich unknown
conditions and obscurants such as smoke or haze do not imply a clear sky. Engines
without luminance-mask CSS support hide both new layers. They add no animation loop, are not observed astronomical
positions, and leave the daytime painting, card colors and terrain treatment intact.

Wide artwork uses the approved50%52% cover camera with stage aspect at most2.1.
Very wide/shallow viewports can reveal lower artwork through normal app scrolling.
Only decorative painting offset and a scroll tail are added; card positions,
content, controls and stored colors are preserved. The sky mask and all grades use
that same camera/visible window. Phones use a viewport-filling cover crop, avoiding
an intrinsic-aspect top strip and empty backing below. The first valid observation
sets its solar grade immediately; later dawn/dusk grading still updates while the
board stays open through the existing minute refresh. A linked title, artist,
source, public-domain/CC0 policy and weather-adaptation credit are available
in the sidebar Help dialog on personal and shared devices. The scene adds no
credit to Tasks, Notes or Calendar content.
Reduced motion, reduced transparency, forced colors, foreground/lifecycle changes
and disposal stop or remove appropriate decoration.

The renderer caps canvas dimensions at1280x800 and precipitation at160particles.
It tracks at most72card hosts but updates at most6visible active rims,24water
beads,6snow catches and12snow fragments globally. Frost SVG is built lazily for
active icy sizes. Dry/hidden rims do not receive continuous style updates. Normal
animation is capped at30FPS; clear/static fallback has no animation loop.

Thunder is a transient opt-in in existing Local Weather sound settings. It requires
a real trusted gesture, canonical enabled nonzero sound, eligible named-theme
sound policy, a running foreground context and the current owner/fresh storm facts.
One artistic delayed event and one bounded normalized2.2second rumble are allowed.
Configuration, opt-out, foreground/lifecycle changes and owner ending cancel both.
Consent is never persisted; existing ui_sounds v1 and completion cues remain intact.

The six selected Cole WebPs total6,720,824bytes and match the approved derivatives.
They load/cache on first Weather use; they do not impose a multi-megabyte install
download on other themes. Decoded source bitmaps can total about38MiB before
canvas/compositor surfaces; compressed bytes are not GPU memory. Provenance and
public-domain attribution accompany the assets. Desktop test/trace evidence does
not establish physical Wall GPU, battery/thermal behavior or speaker audibility.

Integration base: `ac9db4d0880c3725deea89d06246351627ce3cb7`, cache85/schema10060.
No migration, numbering reservation, live configuration write, publication or
deployment is part of this candidate. The release owner reconciles shared paths,
assigns the final cache generation, backs up, publishes/deploys and verifies live.
