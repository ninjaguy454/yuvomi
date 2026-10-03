# Notes canvas and privacy: isolated release record

Base: `70a06cbc1a98d28207c9838fc1a3d48396bbae9a`, schema 10048. Candidate adds schema 10049. Implementation and test evidence live in this independent clone; no production deployment or grants are part of this work.

## Operational boundary

The candidate preserves `device_notes.view/create/edit/delete`. Moving, resizing and organizing require View plus Edit; Create never grants edits/deletion, including to the note just created. Devices see Everyone notes only. Explicit Edit-only API writes preserve the Phase 1 independent grant and return no note payload; readers replacing content must send expected_revision.

All existing notes migrate to Everyone. Restricted audiences are enforced by the shared server authority across routes, layouts, dashboard/counts, search and legacy Wall. No administrator privacy bypass and no identity-picker authentication. Real temporary sessions retain their normal authority only until their existing return/expiry boundary.

## Rollback barrier

Once schema 10049 is used for Private or Selected members notes, **do not start Phase 1 or any older image against that database**. Those versions read Notes without audience filters. Hiding navigation is insufficient. Do not restore a stale database over new household writes.

Build `deploy/Dockerfile.notes-rollback` using the exact candidate image as CANDIDATE_IMAGE. It retains the candidate backend, audience schema/filtering and new client privacy protections, but starts Notes in the existing ordered compact view and hides its canvas toggle. This is deliberately a privacy-preserving presentation fallback, not a schema or data downgrade. Individual card controls and privacy editing remain authorized normally.

If the privacy-preserving fallback fails verification, stop serving the affected app instead of switching to an old image. The parent controls any live release/rollback; these instructions do not authorize live commands.

Phase 1's older-image rollback additionally cannot parse the four device_notes keys without audited permission cleanup. This candidate does not perform that cleanup and must not reuse the Phase 1 rollback script for a privacy rollback.

## Validation record

See the final report for exact candidate/image identifiers and verified counts. Synthetic encrypted migration and real two-connection SQLite conflict tests cover content/geometry separation. Browser tests cover touch/desktop/compact, individual card resizing, accessible controls, audience editing, stale responses and auth-context cleanup. Tests and images use only synthetic databases, temporary browser profiles and isolated containers.

Independent review found and verified fixes for durable Dashboard preview caching, overlapping defaults, and Create-only audit attribution. Dashboard now requires a network response; service worker version `2.54.0-kitchen.5-vidamia.30` clears the old cache identity and never reads or stores Dashboard snapshots. Missing card layouts are packed around authorized saved rectangles without database writes. A genuinely saturated bounded canvas projects `layout.overflow`, forcing compact view until arrangements make room.

Baseline limitations reproduced from unchanged Phase 1 mounted read-only: the full npm chain stops at eleven existing meal-cycle DB-isolation registrations; two device-migration tests still assert maximum schema10043; OpenAPI coverage has existing Rotation/other route gaps and rewards route-parser mismatches. These failures are not recorded as passing. New Notes routes are explicit literals so their contract is checked by the existing route scanner.

Final source checks: `npm run test:notes-canvas` passed 38/38; `npm run test:notes-canvas-browser` passed 15/15, including the actual encrypted full-app scenario with real household authentication, pairing, live revocation and temporary return. Service-worker cache/precache/upgrade plus consumer privacy passed 49/49. Earlier broad device/auth/Notes/schema regression passed145/149, with the four historical migration/OpenAPI failures above. Counts overlap and must not be summed. Independent review findings were fixed and rechecked; no remaining backend finding or frontend blocker.

Browser fixtures disable service-worker installation to avoid racing a hot development checkout, and emulate online status for the real loopback server inside `--network none`. Service-worker privacy/update behavior is verified separately by its dedicated suites. Images are separately verified after this source freeze.
