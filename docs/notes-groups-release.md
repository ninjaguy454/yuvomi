# Notes groups release

Notes stay in their existing records. Grouping adds a persisted rectangle and ordered membership; it does not change content, creator, audience, dashboard pin, task semantics or device permissions.

## Runtime contract

- Migration 10052 adds grouping storage and retry receipts after the existing Notes migrations. P3 also contains migration 10050; use the exact migration ledger, not MAX(version), to identify the phase.
- GET `/notes/board` returns only currently authorized notes and group members. A single visible member appears as an ordinary note with structural arrangement disabled. Partially visible or filtered groups are browse-only.
- POST `/notes/group-operations` applies one atomic command with complete expected revisions and a frozen operation ID. It bypasses generic cached-response idempotency so retries always reauthorize. Membership transitions advance a layout revision even when geometry returns to its old values.
- Group receipts support bounded retry and revision-checked undo. They do not contain note content or audiences. Ordinary authorized deletion performs necessary internal container cleanup without revealing hidden members.
- Selection, overview, placement previews and gestures are transient. Authentication, access, page and relevant board changes invalidate them. Structural writes are not queued offline.

## Independent personal and display arrangements

Migration 10053 adds independent layouts and group membership. An ordinary or temporarily signed-in person uses `human:<user id>`; an anonymous paired display uses `device:<household device id>`. The server derives that owner from the effective authenticated principal. Returning from temporary sign-in restores the display arrangement. Credential rotation and permission changes do not create another layout.

Geometry, canvas lock, stacking, group membership/order and their revisions are independent. Note content, audience, creator, content revision and **Show on Dashboard** remain shared. Human arrangement still requires Notes write authority. Device arrangement requires View plus its independent Move, Pin, Group or Ungroup grants; absent new keys explicitly retain the legacy Edit fallback described in `notes-device-permissions.md`. No live device or Wall Calendar grant is added.

The original `note_layouts`, `note_groups` and `note_group_members` remain the initial arrangement. Reads do not write. Each owner's first authorized structural change atomically copies that seed, preserving fractional coordinates, flags, group IDs, order and revisions. Later owners receive the preserved seed, not someone else's changes. Shared note deletion is the necessary exception: it repairs affected containers in the seed and every initialized layout, including each singleton survivor's own anchor.

The new `note_board_owners`, `note_board_note_layouts`, `note_board_groups`, `note_board_group_members` and `note_board_group_receipts` must all be retained in backups and recovery checks. Group IDs and revisions are interpreted within the server-selected owner. Retry and undo additionally retain the existing authentication-context fence. Pre-isolation receipts remain stored but cannot apply a legacy inverse; clients must reload after their conflict response.

Once independent arrangements are used, keep the 10053-capable backend in both forward and recovery images. Never run the older global-layout writer against this data. The existing mutation-disable fallback preserves owner rows, sequences and receipts; content deletion must still repair all affected owners. Forward, recovery and return verification must compare every scoped table as well as the legacy seed and migration ledger.

## Recovery images

The recovery image is built from the exact forward image. It keeps that backend, migration registry, privacy rules, receipts and grouping data. Never substitute an earlier non-grouping writer or restore an old database over later household edits.

P2 `deploy/build-notes-fallback.mjs` disables the grouped presentation, selects List and hides its view toggle. `VIDAMIA_NOTE_GROUPS_MUTATIONS=0` rejects structural commands, replay and undo with 503. Authorized content, checklist, audience, dashboard-pin and deletion behavior remains available, including required membership cleanup. Returning to the forward image reveals the preserved groups.

P3 `deploy/build-open-tasks-fallback.mjs` additionally pauses new task acceptance and hides its new offer surfaces. Existing tasks, assignments, approval and point semantics stay available. Its recovery image must also preserve Notes groups and disable their structural writes.

Cache identities are allocated separately: P2 `vidamia.60`, P2 recovery `vidamia.60-notes-compact`, combined P3 `vidamia.61`, P3 recovery `vidamia.61-acceptance-paused`. Every browser module and stylesheet introduced by these releases must be precached. Recovery verification supplies the corresponding exact cache identity to `test-sw-upgrade.js` through `VIDAMIA_TEST_SW_CACHE_VERSION`.

The Notes touch cleanup and independent-layout release advanced the forward cache to `vidamia.62`; the Kitchen member-filter correction followed in `vidamia.63`, then Notes drag/save refinement in `vidamia.64`. The combined device configuration, granular Notes permissions, stronger velocity tilt and deferred offer styles candidate uses `vidamia.65`, with matching recovery `vidamia.65-acceptance-paused`. All new configuration modules, permission helpers and styles are precached. Kitchen, independent layouts, sidebar/avatar behavior and the shared-device privacy cache are retained. Router and queued Tasks navigation behavior are unchanged.

## Evidence and ordered release

Freeze a clean commit archive before building. Record the full commit, archive hash, dependency-base image, forward/recovery/browser image IDs and full runtime source hashes. Independently transform another copy of the archive and compare it with the recovery images; a revision label alone is insufficient. The browser recovery derivative must explicitly retain the disabled structural-write setting.

Run grouping, Notes/privacy/device/session, cache and applicable task-acceptance tests against the frozen images. Use only synthetic fixtures for behavior-changing tests. The group recovery helper exercises forward → recovery → forward with one synthetic database, preserving relationship/receipt snapshots and checking authorized edits and deletion cleanup. P3 acceptance recovery uses group-aware P2 seed → P3 upgrade → P3 recovery → P3 return; it must not boot the old P2 writer against P3 data.

Before each live phase, create a fresh encrypted backup using the supported backup operation, verify it by restoring a copy, and rehearse the exact new migrations with prior rows, sequences and ledger entries preserved. Keep the backup and its protected runtime environment separate from source artifacts. Production verification is read-only and does not create synthetic household records or permissions.

Release order remains P2 Notes, observed stability, then P3 open Tasks. Only one deployment owner may switch the service. Verify the actual remote commit, CI results, health and authenticated/device projections for each deployed image. Physical paired-device observations must be distinguished from synthetic browser and read-only API checks.

## Existing test limitations

The unchanged baseline full npm entrypoint stops at the DB-isolation guard for existing meal-cycle/browser suites. The locale parity test also reports two existing English settings keys absent from the German reference. Preserve and report those failures separately from release-specific checks; do not describe the complete repository suite as green. Final release manifests must record any additional baseline failures independently reproduced during integration.
