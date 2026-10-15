# Hidden Night Shift game

Night Shift adds a deliberate, local camera-survival game to the standard Dashboard. With Night Shift selected, the small CAM 01 badge opens a start screen. Nothing moves or scares before Start. The passive theme artwork and normal Dashboard actions remain unchanged. Wall mode, Dashboard editing, other routes/themes and denied Dashboard access do not expose the badge. A shared display follows its existing Dashboard access; playing never grants permission to change its locked theme.

## Interaction and rules

Survive a 90-second simulation from 12 AM to 6 AM. Choose among five live cameras, watch the crew move and close the correct office shutter when a doorway indicator lights. Reopen clear shutters to conserve power. The monitor and closed shutters consume additional power. A loss identifies the character; both win and loss offer Restart or Exit.

| Character | Behavior | Defense |
| --- | --- | --- |
| Bonnie | Stage, dining, west hall, left doorway | Hold the left shutter for 2 continuous seconds |
| Chica | Stage, dining, east hall, right doorway | Hold the right shutter for 4 continuous seconds |
| Freddy | East route; watching his current live camera freezes movement; lowering the monitor accelerates him | Watch his camera, or hold the right shutter for 3 seconds |
| Foxy | Cove tension rises while neglected and falls while watched; at 100% he sprints west | Watch CAM 05, or hold the left shutter for 2 seconds; a blocked sprint costs 4% power |

Mouse and touch use the camera map, shutters and monitor controls. Keyboard: 1–5 cameras, A/D shutters, C monitor, P pause/resume, Escape exit. While the console is open, its capture handler keeps Dashboard search, help, create and navigation shortcuts inactive; native Tab/Enter/Escape defaults remain available. Exit releases that handler and restores normal Dashboard shortcuts. The visible UI deliberately keeps only the HUD, map, controls and settings; these rules stay in documentation. Leaving the tab pauses the simulation. Browser Back closes the console before leaving the Dashboard.

## Motion, audio and ownership

Sound + scream defaults on for a new game, independently of household sound preferences. Opening the console never creates or starts audio; deliberately pressing Start is the activation gesture. Quiet cues and an original one-second synthesized vocal/mechanical scream are then permitted on a standard loss. A saved game-local mute or zero volume remains silent, and platform audio refusal never prevents play. No audio is downloaded or recorded. The waveform peak is normalized to 0.84 and maximum volume/gain caps its output peak at 0.0882. These signal limits do not establish perceived loudness on physical speakers or headphones.

Visual jumpscares default on (Gentle is unchecked). Standard loss shows an internal character overlay for 1.2 seconds with one lunge, without flashes or strobing. Gentle or reduced motion uses a still original portrait and suppresses the lunge and scream. Explicit game settings remain selected through restart and viewport changes. Only Sound, Gentle and volume choices are saved in private browser-local keys scoped to the current member or device; explicit mute/opt-out survives reopening/reload. No auth credential is stored, no server preference is written, and no household/device sound or appearance setting changes. Unidentified contexts or unavailable local storage still permit play without persistence.

The encounter intercepts pointer input, with result actions disabled until the visible scare finishes. A fresh pointer press is required to activate a revealed result action, so a touch begun on the old gameplay cannot turn into Exit or Restart after the layout changes. Keyboard and assistive-technology activation remain available on the results. Header Exit, Escape/Back, mute and Gentle remain available during the encounter. Mute, volume changes, restart, Gentle/reduced-motion changes and tab leave stop active voices. Exit, navigation, theme/context changes and Dashboard disposal cancel the animation frame and encounter timer, remove the console and private stylesheet, release overlay history and close the AudioContext. An in-flight opening is abortable and cannot reopen after its Dashboard leaves.

## Viewport fit

The console uses one definite height budget inside the current visual viewport, subtracting browser safe-area insets. Header/HUD, camera map, shutters, monitor and sound/Gentle controls remain in view without console or page scrolling. Artwork takes the flexible space; controls keep at least 44 px targets. Short landscape views place header and HUD alongside each other and use a compact camera grid. Narrow portrait views reduce spacing rather than scaling the whole UI. Start, pause, scare and win/loss results share the same bounded stage.

Visual-viewport resize/offset events and window resize update the private bounds without restarting play or changing settings. The console cancels its pending viewport frame and listeners on disposal. Page scroll locking is scoped to the presence of this open console and disappears with it. These rules apply to the standard Dashboard on phone, tablet and display-sized viewports; the existing Wall-mode entry guard remains unchanged.

All scenes and character/scare drawings are original SVG fan art; the existing theme asset remains byte-identical. No franchise recordings, extracted game assets, dependencies, services, telemetry, household preference writes or schema changes are added. Session gameplay stays in memory; only the three explicit game-control choices described above use browser-local storage. The console has no product debug/cheat interface. Tests inject their own time accelerator.

## Integration and verification

The standard Dashboard has one import, one mount and one disposer call. The lightweight entry module lazy-loads the console after the badge is activated. IDs, SVG references, CSS selectors and keyframes are private to the console. Six new files are added to service-worker precaching. The release owner must allocate the combined cache generation when composing with other changes; this contribution keeps the baseline cache number and schema unchanged.

Run `npm run test:night-shift-game` for the 21 model/audio/settings/entry-eligibility tests. `npm run test:night-shift-game-browser` uses the existing Puppeteer dependency and installed Edge (or `PUPPETEER_EXECUTABLE_PATH`) against a temporary synthetic database and the real application. It blocks external requests and mutes OS audio while inspecting Web Audio calls. Set `NIGHT_GAME_REVIEW_DIR` to export screenshots and JSON evidence.

Browser coverage includes deliberate/lazy entry, all four attributed losses and synchronized scream, mute/restart/exit, a complete winning simulation, Gentle and reduced motion, mouse/keyboard/touch, Escape/focus, Back, route/theme/auth cleanup, delayed-stylesheet cancellation, scoped camera handlers, locked shared-display settings and identical task/points/settings/device database snapshots. Start, gameplay, pause, scare, loss results and win results are measured at 320×480, 360×400, 390×640 (top/bottom safe areas), 600×760, 800×480, 1024×600, 568×280, 844×360 (side/bottom safe areas), 1440×900 and 2560×1440. Tests reject section overflow, clipped/obscured controls and sub-44px targets. Live orientation/resize and a separately offset browser-chrome visual viewport preserve state. Wheel/touch scrolling, encounter taps and presses held through a loss are covered. Each browser scenario owns its real server/request-quota store; production rate limiting remains intact.

The focused suite also covers existing Night Shift theme, shared-device permissions, overlay history and UI sounds. On Windows the canonical `npm test` stops at the existing POSIX-only `DB_PATH=:memory:` script for schema reconciliation; this change does not repair unrelated test tooling.

Limits: Windows headless Edge only; physical Android/tablet browser chrome, subjective scare/audio, screen readers, Firefox and Safari remain untested. Safe-area insets are exercised through the browser's emulation; the additional offset/chrome case controls the real VisualViewport event target. Long frames are capped at 100 ms, so below 10 FPS the simulation takes longer in wall-clock time; power and threats slow together. Essential controls have English/German copy, with English fallback for other locales; some accessible state announcements remain English. Publication/deployment and composed-release validation belong to the release owner.

The user separately verified that the scare works in the actual app and attributed the wall-calendar failure to the Full Kiosk browser. No kiosk configuration is changed here. The covered-result tap defect was reproduced independently in ordinary browser emulation; its input guard is not presented as the cause or remedy for that kiosk limitation.
