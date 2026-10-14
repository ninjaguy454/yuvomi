# Local Weather Scene Implementation Plan

> **For agentic workers:** Execute the independent provider, renderer and audio domains with superpowers:dispatching-parallel-agents; the coordinator owns appearance integration and one whole-candidate independent review. Steps use checkbox syntax for tracking.

**Goal:** Integrate the approved Crawford Notch Weather preview into Local Weather using household provider facts without changing existing weather responses or authorization.

**Architecture:** A separate scene route returns the unchanged seven-field theme observation and a versioned, strictly whitelisted scene projection from the same cached provider response. The existing appearance reader optionally reads that envelope and owns a disposable decorative renderer; sound uses the existing canonical engine with a trusted, transient opt-in.

**Tech Stack:** Existing Node/Express ES modules, browser Canvas2D/SVG/CSS, node:test and Puppeteer. No new dependency or database migration.

**Spec:** `../../local-weather-scene.md`; detailed original review artifacts in `../../../../review/weather-landscape-prototype/scene-facts-contract.txt`, `weather-integration-plan.txt`, `weather-integration-ac9db4d.txt`, and approved `weather-review.html` SHA256 `3fd197cb744870e741ae34722abb1b12ced2fc75e37f17e9b313048344388bff`.

## Global Constraints

- Baseline `ac9db4d0880c3725deea89d06246351627ce3cb7`, cache85/schema10060; no Weather version reservation or numbering migration.
- Keep legacy widget and seven-key theme responses compatible. Household appearance cannot use personal location overrides or client coordinates.
- Preserve Dashboard/Weather read grants, Wall/device post-await validation, freshness/ownership/abort fences and offline API privacy.
- Only reported supported precipitation types are direct facts. Gust timing, sky illumination and residue are bounded illustrations; no frost, blizzard, dry storm or actual strike is fabricated as a reported fact.
- No task/profile/grant changes, no moving card hit boxes, no additional child-photo visibility, no theme catalog/preferences schema change.
- Preserve Night Shift's theme sound-off guard. Thunder defaults off, is transient, requires trusted activation, enabled canonical sound and foreground owner, and cancels at lifecycle boundaries.
- Preserve both prototype checkpoints and original evidence. Use the six unchanged selected Cole assets, visible attribution and provenance.
- Synthetic local test data only. No independent publication, deployment, settings writes or live provider/location access.

## Review Focus

- Missing or invalid units/amounts must remain unknown; absent optional rain cannot imply a dry thunderstorm.
- Late responses after household/device/Wall owner changes must erase richer facts and audio even when the coarse theme ID stays the same.
- Window resize, very wide viewports and full app card mutations must keep art/mask registration and stationary targets without per-frame layout work.
- Muted themes, consent before mode selection, settings saved after an await, and foreground changes must preserve trusted activation and cancellation.
- Offline/expired/unsupported scene data must leave readable coarse chrome and clear richer residue rather than retaining another owner's conditions.

### Task 1: Provider scene projection and routing

**Files:** `public/utils/weather-scene-facts.js`, `public/utils/weather-appearance.js`, `server/routes/weather.js`, `server/routes/wall.js`, `server/services/device-weather.js`, `server/services/device-app.js`, `server/services/device-app-paths.js`, `server/openapi/paths/weather.js`, `docs/paired-device-weather.md`, focused scene/route tests.

**Interfaces:** Export `normalizeWeatherScene(value, theme, now=new Date())` and `normalizeWeatherSceneEnvelope(value, now=new Date())`, returning validated v1 facts/null and `{theme,scene}`/null. Scene routes return `{data:{theme,scene}}`/`{data:null}`. Preserve `normalizeWeatherObservation` and provider cache sharing.

- [ ] Write and run failing domain/provider/route checks for whitelist, timestamps, units, unknown/missing facts, shared fetch/cache, household-only location and late authorization changes.
- [ ] Implement the exact projection and route boundary; no raw provider body/location/credentials escape.
- [ ] Run scene, existing weather/access/device tests and record actual results.

### Task 2: Approved decorative renderer

**Files:** `public/utils/local-weather-scene.js`, focused helper modules under `public/utils/local-weather-scene/`, `public/styles/local-weather-scene.css`, six `public/assets/weather/cole-*.webp` and provenance/credit, focused renderer tests.

**Interfaces:** Export `mountLocalWeatherScene({onFlash=()=>{}}={})` returning `{update({theme,scene}),dispose(),getStats()}`. `onFlash({id,delayMs})` queues one artistic delayed rumble. Renderer never opens audio or changes named-theme variables/task content. It clears richer state when scene becomes null and disposes all observers/listeners/nodes on owner exit.

- [ ] Write and run failing renderer checks for lifecycle, static fallback, bounds, unchanged card transforms and no calls after disposal.
- [ ] Port approved registered cover camera, varied mask-qualified sky pulses, shared bounded dynamics/residue/solar treatment and stationary card rim materials. Missing wind does not acquire a fabricated observed direction or gust.
- [ ] Run domain/browser checks with current app cards, media fallbacks and ownership boundaries; browser work is serialized by coordinator.

### Task 3: Canonical, transient thunder

**Files:** `public/utils/ui-sounds.js`, `public/components/ui-sound-settings.js`, necessary locale keys, focused sound tests.

**Interfaces:** Export `setWeatherThunderOptIn(value,event)` (trusted enable), `weatherThunderEnabled()`, `queueWeatherThunder({id,delayMs,isCurrent=()=>true})`, `cancelWeatherThunder({resetOptIn=false}={})`. Queue uses an already trusted activated context, session-only consent and canonical config/theme eligibility. The optional owner/facts gate is rechecked immediately before delayed playback. No persisted ui_sounds contract change. UI appears only for Local Weather and supports mode/consent in either order.

- [ ] Write and run failing checks for default silence, trusted activation order, muted theme/zero volume, one pending event/voice, mode/volume/pack changes and owner/foreground disposal.
- [ ] Add bounded rumble using the approved waveform/envelope and canonical gating, preserving completion sounds and existing engine semantics.
- [ ] Run existing and new sound/settings checks; no browser sound or desktop focus changes.

### Task 4: Appearance ownership and release-ready verification

**Files:** `public/utils/local-weather-runtime.js`, `public/utils/named-appearance-runtime.js`, additive `public/styles/named-appearance.css`, `public/sw.js`, `package.json`, full app fixture/tests and handoff evidence.

**Interfaces:** `startLocalWeather({sceneMode:false,...})` preserves legacy `getValue()` and adds `getScene()` for optional envelope mode. Named appearance requests scene mode, updates effects even when coarse theme ID stays unchanged, and disposes renderer/audio at ending ownership.

- [ ] Write/run failing reader/mount tests for envelope, unchanged legacy reads, same coarse theme/new facts, expiration/offline/permission/owner races.
- [ ] Integrate the three interfaces and static registrations; preserve cache85 until release owner assigns final generation and keep API scene responses uncached.
- [ ] Run focused domain and real-app Dashboard/Tasks/Calendar/Wall/device suites; inspect desktop/mobile pixels, keyboard/touch/contrast/media fallbacks and stationary bounds.
- [ ] Measure cold/warm desktop rendering and repeated cleanup with recording off; report asset/compositor/device limits honestly.
- [ ] Run independent whole-candidate review, fix substantive findings with regression tests, freeze a commit/bundle/patch and integrity evidence, and hand deployment to release owner.

## Authorization and execution ruling

The parent supplied Duane's explicit approval at22:55UTC (“Well let's deploy it. This has everything I want.”) and expressly instructed production integration against the named baseline, with release-owner deployment. That instruction authorizes executing this reconciled plan; no additional skill-based approval pause is introduced. Parallel workers have disjoint file ownership, do not commit shared work or launch browsers without a slot, and report to the coordinator. The shared-interface names above are the contract between workers.

Ruling: The real app uses internal scrollports in a fixed-height shell. The artwork retains the approved full-width cover camera and maximum stage aspect2.1. On extreme wide/shallow viewports, ordinary app scrolling reveals the lower artwork; only a decorative scroll tail and painting offset are added, preserving card positions and existing controls. Mobile retains the whole painting. Sky point selection accounts for the visible scroll window; no dim underpainting/side-band fallback is used.
