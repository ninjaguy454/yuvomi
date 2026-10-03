# Phase 3 recovery certification

Forward runtime source: `06887f897034dec18a242b6d02826ce874c7c6e4`, local image `yuvomi:open-tasks-test-06887f89`, digest `sha256:3b8323a561c522eb112353a3b816212d37ea3594cc4aee5da7d066da21df57a9`. Its base contains Phase 2 functional `2ad6323ade455d07329a9580fa782f5c684b61db` plus `dc9adab80f2b35a577a36c051a1ebb63e520fc23` (the final audience-copy fix cherry-picked from Phase 2).

Exact Phase 2 recovery probe: source `79feabad0ade0a50fceb8472f952950b14da88ff`, image `yuvomi:notes-canvas-test-79feabad`, digest `sha256:50298d727baf49f915c53d6d419275f638e74957ae7610b160fe66ef2f7ee360`. No pre-privacy image was used. Phase 2 knows migration 10049; Phase 3 adds only migration 10050, the receipt table. The recovery process leaves schema 10050 and its migration ledger intact.

## Finding and certified alternative

The Phase 2 image can open the upgraded encrypted database, read accepted ordinary task assignments, preserve note audiences/content/layouts, and edit an authorized private note. It is **not a supported general rollback** after Phase 3 writes device settings: `normalizeDevicePermissions` / `updateDevice` reject the persisted `tasks.accept_with_helpers` and `device_tasks.accept_with_helpers` keys as unknown actions. Removing those keys would mutate household permissions and was neither attempted nor selected as recovery.

The fallback derives from the exact Phase 3 image. It preserves its schema, capability parser, task assignment rules, receipt records, authorization, and complete Notes privacy/canvas implementation. Image-only patches make offer projections unavailable and make acceptance options and confirmations return 503 with `acceptance_paused`; existing receipt attempts are also paused. The new board and filter are hidden, incoming `offers=1` page state resets to ordinary Tasks, and the service worker gets `-vidamia.31-acceptance-paused`. Existing regular Tasks remain available. Stale clients cannot create new acceptances. The fallback recipe fails if an expected source signature changes.

Use `deploy/Dockerfile.open-tasks-fallback` with an explicit CANDIDATE_IMAGE and REVISION. Its separate Docker ignore file admits only the build helper in addition to normal runtime build inputs. The tested immutable fallback digest and certification commit are recorded in the parent `open-tasks-release.json` and rehearsal manifest; never select a floating tag without comparing its digest.

## Rehearsal and evidence

`deploy/certify-open-tasks-rollback.ps1 -FallbackImage <exact-local-fallback-tag>` creates a new synthetic-only directory, checks local image metadata, and sequentially runs five isolated containers with no network, no published ports, and only the test helper plus synthetic fixture mounted:

1. Phase 2 seeds an encrypted household containing Private, Selected, and Everyone notes, recipients, distinct canvas geometry, open regular roots/subtasks, and a scoped device.
2. Phase 3 migrates the same file, verifies unchanged seeded content, accepts solo and helper/partial work, and uses two real encrypted connections/processes for a competing claim and an identical retry. One contender wins; identical retries commit once and replay once. It saves a synthetic helper permission, four receipts, and zero reward entries.
3. Phase 2 reopens that same file, confirms all Notes/ACL/layout/task/assignment/responsibility/receipt snapshots, proves the device-setting incompatibility without permission cleanup, and makes an authorized private-note edit.
4. The fallback retains those snapshots, blocks new acceptance and stale retry HTTP requests, preserves accepted task detail, allows editing device settings with the new saved keys, and edits a selected note without changing its audience or geometry.
5. The forward image reopens the current file, retains fallback edits and accepted assignments, and replays the original receipts with zero database changes, including no duplicate notification/outbound writes. The receipt count remains four and reward count zero.

Every stage checks encrypted storage, foreign keys, and database integrity. Snapshot comparisons cover Notes/ACLs/layouts/tasks/assignments/responsibilities/receipts; this is not an exhaustive equivalence claim for every household table or external integration. No backup restore, backward migration, deletion, or permission normalization cleanup occurs.

The candidate's registered browser suite passes 21/21 and now covers every requested branch: no helpers; helpers without children; helpers with zero, partial, and all eligible children allocated; protected steps; cancellation; Back removing helpers and clearing hidden allocations; uncertain identical retry; conflict reload; and scoped paired selection with unchanged device identity/rights. The real encrypted app walkthrough remains part of that suite. The actual fallback image passes 145/145 Notes, device Tasks, ordinary task routes, reward integrity and API cache checks. Final counts and exact logs are in `open-tasks-release.json`.

The final full npm command ran the DB and schema-reconcile suites, then stopped at the existing DB-isolation guard listing eleven meal-cycle registrations. This is the same known failure reproduced on the unchanged Phase 1 baseline; the full chain is not claimed to pass. Earlier broader candidate checks remain 251/258, 107/110, and API/idempotency 25/26, with each failure reproduced on unchanged Phase 2 as recorded in the release report. Focused forward runtime remains 71/71, backend/drafts 33/33, Notes 38/38 and cache/refresh 54/54. Counts overlap.

## Eventual operational procedure

This document grants no production authorization. After the parent/user approves a target and release window: retain a fresh encrypted backup and record the existing image digest and database path; stop the forward writer cleanly; start the certified fallback with the **same current database, encryption key, session secret and existing configuration**. Do not restore an older snapshot over subsequent writes. Verify startup/integrity, paired Notes audiences, existing task assignments, and paused acceptance. Use the distinct service-worker update through the normal app update flow; server-side 503 protection covers older clients meanwhile.

To return, stop the fallback writer cleanly and start the exact certified forward image against that same current database and configuration. Verify existing assignments and receipt retry behavior. Never run both versions as independent writers during transition. Preserve the Phase 2 barrier against all pre-privacy images. Production deployment and any helper permission activation remain separate user decisions; both new capabilities default off.
