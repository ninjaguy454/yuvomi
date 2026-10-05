# Notes groups release

Notes stay in their existing records. Grouping adds a persisted rectangle and ordered membership; it does not change content, creator, audience, dashboard pin, task semantics or device permissions.

## Runtime contract

- Migration 10052 adds grouping storage and retry receipts after the existing Notes migrations. P3 also contains migration 10050; use the exact migration ledger, not MAX(version), to identify the phase.
- GET `/notes/board` returns only currently authorized notes and group members. A single visible member appears as an ordinary note with structural arrangement disabled. Partially visible or filtered groups are browse-only.
- POST `/notes/group-operations` applies one atomic command with complete expected revisions and a frozen operation ID. It bypasses generic cached-response idempotency so retries always reauthorize. Membership transitions advance a layout revision even when geometry returns to its old values.
- Group receipts support bounded retry and revision-checked undo. They do not contain note content or audiences. Ordinary authorized deletion performs necessary internal container cleanup without revealing hidden members.
- Selection, overview, placement previews and gestures are transient. Authentication, access, page and relevant board changes invalidate them. Structural writes are not queued offline.

## Recovery images

The recovery image is built from the exact forward image. It keeps that backend, migration registry, privacy rules, receipts and grouping data. Never substitute an earlier non-grouping writer or restore an old database over later household edits.

P2 `deploy/build-notes-fallback.mjs` disables the grouped presentation, selects List and hides its view toggle. `VIDAMIA_NOTE_GROUPS_MUTATIONS=0` rejects structural commands, replay and undo with 503. Authorized content, checklist, audience, dashboard-pin and deletion behavior remains available, including required membership cleanup. Returning to the forward image reveals the preserved groups.

P3 `deploy/build-open-tasks-fallback.mjs` additionally pauses new task acceptance and hides its new offer surfaces. Existing tasks, assignments, approval and point semantics stay available. Its recovery image must also preserve Notes groups and disable their structural writes.

Cache identities are allocated separately: P2 `vidamia.60`, P2 recovery `vidamia.60-notes-compact`, combined P3 `vidamia.61`, P3 recovery `vidamia.61-acceptance-paused`. Every browser module and stylesheet introduced by these releases must be precached. Recovery verification supplies the corresponding exact cache identity to `test-sw-upgrade.js` through `VIDAMIA_TEST_SW_CACHE_VERSION`.

## Evidence and ordered release

Freeze a clean commit archive before building. Record the full commit, archive hash, dependency-base image, forward/recovery/browser image IDs and full runtime source hashes. Independently transform another copy of the archive and compare it with the recovery images; a revision label alone is insufficient. The browser recovery derivative must explicitly retain the disabled structural-write setting.

Run grouping, Notes/privacy/device/session, cache and applicable task-acceptance tests against the frozen images. Use only synthetic fixtures for behavior-changing tests. The group recovery helper exercises forward → recovery → forward with one synthetic database, preserving relationship/receipt snapshots and checking authorized edits and deletion cleanup. P3 acceptance recovery uses group-aware P2 seed → P3 upgrade → P3 recovery → P3 return; it must not boot the old P2 writer against P3 data.

Before each live phase, create a fresh encrypted backup using the supported backup operation, verify it by restoring a copy, and rehearse the exact new migrations with prior rows, sequences and ledger entries preserved. Keep the backup and its protected runtime environment separate from source artifacts. Production verification is read-only and does not create synthetic household records or permissions.

Release order remains P2 Notes, observed stability, then P3 open Tasks. Only one deployment owner may switch the service. Verify the actual remote commit, CI results, health and authenticated/device projections for each deployed image. Physical paired-device observations must be distinguished from synthetic browser and read-only API checks.

## Existing test limitations

The unchanged baseline full npm entrypoint stops at the DB-isolation guard for existing meal-cycle/browser suites. The locale parity test also reports two existing English settings keys absent from the German reference. Preserve and report those failures separately from release-specific checks; do not describe the complete repository suite as green. Final release manifests must record any additional baseline failures independently reproduced during integration.
