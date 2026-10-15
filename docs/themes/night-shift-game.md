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

Sound + scream defaults off on every opening and is independent of household sound preferences. Enabling it and deliberately starting play permits quiet cues and an original one-second synthesized vocal/mechanical scream on a standard loss. No audio is downloaded or recorded. The waveform peak is normalized to 0.84 and maximum volume/gain caps its output peak at 0.0882. These signal limits do not establish perceived loudness on physical speakers or headphones.

Standard loss shows an internal character overlay for 1.2 seconds with one lunge, without flashes or strobing. Gentle or reduced motion uses a still original portrait and suppresses the lunge and scream. Mute, volume changes, restart, Gentle/reduced-motion changes and tab leave stop active voices. Exit, navigation, theme/context changes and Dashboard disposal cancel the animation frame and encounter timer, remove the console and private stylesheet, release overlay history and close the AudioContext. An in-flight opening is abortable and cannot reopen after its Dashboard leaves.

All scenes and character/scare drawings are original SVG fan art; the existing theme asset remains byte-identical. No franchise recordings, extracted game assets, dependencies, services, data collection, preference writes or schema changes are added. Session game state and its controls stay in memory. The console has no product debug/cheat interface. Tests inject their own time accelerator.

## Integration and verification

The standard Dashboard has one import, one mount and one disposer call. The lightweight entry module lazy-loads the console after the badge is activated. IDs, SVG references, CSS selectors and keyframes are private to the console. Six new files are added to service-worker precaching. The release owner must allocate the combined cache generation when composing with other changes; this contribution keeps the baseline cache number and schema unchanged.

Run `npm run test:night-shift-game` for the 18 model/audio/entry-eligibility tests. `npm run test:night-shift-game-browser` uses the existing Puppeteer dependency and installed Edge (or `PUPPETEER_EXECUTABLE_PATH`) against a temporary synthetic database and the real application. It blocks external requests and mutes OS audio while inspecting Web Audio calls. Set `NIGHT_GAME_REVIEW_DIR` to export screenshots and JSON evidence.

Browser coverage includes deliberate/lazy entry, all four attributed losses and synchronized scream, mute/restart/exit, a complete winning simulation, Gentle and reduced motion, mouse/keyboard/touch, Escape/focus, Back, route/theme/auth cleanup, delayed-stylesheet cancellation, scoped camera handlers, locked shared-display settings and identical task/points/settings/device database snapshots. Layouts exercised: 1440×1000, 390×844, 320×700 and 844×390, with no horizontal overflow and visible controls at least 44 px.

The focused suite also covers existing Night Shift theme, shared-device permissions, overlay history and UI sounds. On Windows the canonical `npm test` stops at the existing POSIX-only `DB_PATH=:memory:` script for schema reconciliation; this change does not repair unrelated test tooling.

Limits: Windows headless Edge only; physical devices, subjective scare/audio, screen readers, Firefox and Safari remain untested. Long frames are capped at 100 ms, so below 10 FPS the simulation takes longer in wall-clock time; power and threats slow together. Essential controls have English/German copy, with English fallback for other locales; some accessible state announcements remain English. Very short landscape displays may scroll for lower controls. Publication/deployment and composed-release validation belong to the release owner.
