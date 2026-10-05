# Avatar task assignment handoff

The acceptance dialog now uses a participant-avatar strip and stationary subtask targets. Tap a target to choose or clear its recipient; drag an avatar to overwrite a target; tap, keyboard-activate, or long-press an avatar to view the existing Task person card. Assigning none or some subtasks remains valid. Allocation appears only when helpers are selected and subtasks exist.

## Source and ownership

- Feature commit: `260874c70ae692f41f625b50b124863d3570da34`.
- Base: reviewed P3 `34dcc4d1187fa869463f56e5aace75a10fceced5`.
- Source tree: `6b1166c7f80ea81ff98d76ba2a780bd05efa45c9`.
- Branch: `feat/avatar-task-assignment`.
- Worktree: `C:/Users/Duaner/Documents/Codex/2026-10-04/task/vidamia-avatar-assignment`.
- Main/Notes controller owns integration and deployment. This worker made no push, deployment, live-data change, permission grant, or edit to the Notes checkouts or test containers.

This is one coherent additive feature commit because the presenter, gesture controller, acceptance renderer, shared styles, cache entries and preservation tests must land together. The following documentation commit records its verification; it changes no runtime source.

## Preserved contracts

The draft utility and server acceptance implementation are unchanged. Numeric recipient IDs, primary-as-self, scoped paired recipients, helper capabilities, complete child snapshots, protected children, frozen operation IDs and the existing atomic final Confirm remain authoritative. A device recipient choice does not authenticate that person. Selection, drag, person-card opening, Back and Cancel issue no acceptance writes. Acceptance awards no points.

Abbreviated chooser names use the shared collision metadata. Full names remain in person cards and confirmation. Cards use supplied authorized fields only; they do not fetch or enrich from a richer roster. Unsafe or remote photo sources fall back to initials. No schema, dependency, API or permission was added. Bounty copy and ordinary Task approval semantics are unchanged.

## Verification evidence

Evidence is under `.qa/avatar-evidence/` in this worktree. Each run records the source tree, image ID, command inputs, exit code and TAP counts. Tests ran in immutable Node24 images with synthetic data, no published ports, no network and no source/dependency mounts.

| Run | Result |
| --- | --- |
| Exact-commit acceptance policy, races, capabilities, draft/context, migration, device and member-presentation contracts | 101/101 passed; `release-260874c7-contracts.json` |
| Exact-commit combined avatar, existing acceptance, real-app, visual, modal and cache pack | 177/177 passed; `release-260874c7-ui.json` |
| Reviewed final-tree person card, allocation, real-app entry points and visual matrix | 61/61 passed; `candidate-final-browser-layout.json` |
| Same-tree repeated browser Back contract | 5/5 passed; `candidate-final-back-repeat-1.json` through `-5.json` |
| Same-tree existing acceptance suite, isolated rerun | 34/34 passed; `candidate-final-acceptance-recheck.json` |
| Exact-commit forward/paused recovery chain | Five stages passed; `release-260874c7-recovery.json` |

Coverage includes mouse and native touch drag, edge scrolling, capture loss, long press, keyboard chooser/clear, optional allocation, protected targets, helper removal, scoped duplicate labels, no enrichment, auth teardown, unknown-outcome frozen retry, browser Back, nested focus and outside dismissal. The real encrypted-database flows enter from Notes and Tasks, exercise scoped paired recipients, and assert no early writes or points.

The visual matrix covers 320x720, 390x844, 844x390, 768x1024, 1280x800 and 1920x1080, light/dark, RTL, 200% text, long/duplicate names, ten participants and long scrolling lists. Actual screenshots were inspected. The small-landscape layout exposes the first target; enlarged chooser headings are bounded while retaining their complete accessible name. Exact-commit screenshots are in `release-260874c7-pixels/` (150 images including full-app captures); the reviewed same-tree captures are also retained in `candidate-final-pixels/`.

Independent whole-branch review found two P2 issues: native Back dismissed the parent draft, and reopening a chooser could focus a recipient below its visible viewport. Both were reproduced in frozen RED tests and fixed. The final reviewer reported no remaining findings. The mobile Back regression now checks actual parent/marker/registry state and the next route transition instead of assuming an exact count of internal popstate events.

## Immutable recovery

Forward test image: `vidamia-avatar-release-260874c7:20261005`

`sha256:6d04da2a9d2696e6d06239515c1479d0c410a63b380d818c1e96219ec1fbd5bc`

Acceptance-paused derivative: `vidamia-avatar-release-260874c7-paused:20261005`

`sha256:9bb84420b3920163dc44de78fc2f7a689e4863ab240fddbc1e8361fac2c24cfd`

The sequence was P2 seed, avatar P3 upgrade, P2 compatibility probe, paused P3, and avatar P3 return. It used a new synthetic encrypted data volume, `vidamia-avatar-cert-release-260874c7`. Only that data volume was mounted. The seed image retains P2 source/dependencies and copies only the frozen certification helper. Exact seed identities are in the recovery manifest.

All stages preserve integrity, private/selected/shared Notes access, canvas position locks/layers and resize behavior. Upgrade creates four acceptance receipts and zero reward-ledger rows. The old P2 probe confirms it rejects persisted P3 helper-capability keys, so it is not the data-compatible acceptance recovery. Paused P3 retains those capabilities and editable device configuration, hides offers, returns 503 for acceptance and keeps existing Tasks/Notes usable. Return replays receipts without duplicate or other database writes; points remain zero.

## Known baseline failures

- Locale parity: English alone contains existing `settings.pageDevices` and `settings.pageDevicesDescription`. The exact base and final tree both produce 67/68 locale/plural passes with the same parity failure. New avatar keys and placeholders pass. This patch does not change unrelated settings translations.
- Existing member-label browser suite: the Notes author-filter/delete wait fails on the exact base (5/6) and the early feature run. Task presenter coverage passes. Notes source was not changed to address this separate failure.
- One final-tree acceptance fixture navigation timed out at its existing 6-second limit while several browser containers ran concurrently. The unchanged image, assertions and timeout passed all 34 acceptance tests when rerun alone. Retain both logs rather than treating the failed attempt as a pass.

## Main/Notes integration

Apply the feature commit to the reviewed grouping-aware P3 integration branch, not P2. Preserve the Notes worker's current changes while reconciling `public/styles/tasks.css`, the locale catalogs and release files.

The avatar branch uses cache suffix `-vidamia.60-avatar`, with paused suffix `-vidamia.60-avatar-acceptance-paused`. The combined release owner must choose its final cache identity and update `public/sw.js`, `test/test-sw-upgrade.js`, `deploy/build-open-tasks-fallback.mjs` and `test/helpers/task-acceptance-rollback.mjs` consistently. Retain precache entries for `task-acceptance-allocation.js`, `task-person-card.js` and `task-avatar-gesture.js`.

Build and verify the combined source after integration, including the Notes/grouping privacy and recovery tests. These avatar images certify the P3 base at schema 10051, not the later grouping migration or a combined deployment. The main controller must derive the combined paused image from that combined candidate. The local test images contain frozen tests/development dependencies and are verification artifacts, not a substitute for the main controller's production release build.
