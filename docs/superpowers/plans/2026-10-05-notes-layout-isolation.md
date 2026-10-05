# Notes Layout Isolation Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the owned tasks. Root serializes staging and commits. The user explicitly authorized implementation without another design gate.

**Goal:** Make personal-user and paired-device canvas layouts and group membership independent while preserving shared Notes content and access.

**Architecture:** Server-derived stable owners with read-only legacy seeding and atomic first-write initialization. Scoped tables and owner-aware services retain the existing API and authentication-context fences.

**Tech Stack:** Existing Node/Express, encrypted SQLite, native browser ES modules and Chromium regression infrastructure; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-05-notes-layout-isolation-design.md`

## Global Constraints

- Base: verified cleanup commit `0575c6bb85a6084817dbb4bc2d1949f128ff24cc`; existing isolated worktree, branch `feat/notes-layout-isolation`.
- No deployment, service restart, live household mutation or expanded Wall Calendar grant.
- Preserve note content/privacy and fractional legacy coordinates; append migration 10053 without changing historical migrations.
- Use server-derived `human:<id>` / `device:<id>` identities; keep rotating authentication contexts separate.
- Write meaningful failing behavior tests before product edits; freeze RED and GREEN evidence with source identity.

## Review Focus

- A scope initialized after another scope changes must still inherit the unchanged seed (Task 1).
- Shared deletion must repair all affected owner groups without exposing hidden survivors (Task 2).
- A guessed foreign group or receipt ID must never mutate another owner, even when group IDs coincide (Task 2/3).
- Temporary sign-in/return and delayed writes must not cross effective identities or grant new rights (Task 3/4).
- Migration restart, rollback and disabled-mutation recovery must preserve every scoped table and counter (Task 1/4).

### Task 1: Owner storage and migration

**Files:** new `server/services/note-layout-owner.js`, new `server/services/note-layout-owner-schema.js`, `server/db.js`, `server/db-schema-test.js`, new `test/test-note-layout-isolation-migration.js`.

**Interfaces:** export `noteLayoutOwnerKey(principal)`, `hasNoteLayoutOwner(d,key)`, `ensureNoteLayoutOwner(d,key)`, `nextNoteGroupId(d,key)`. Scoped tables follow the spec. Read helpers must select only the owner or immutable seed. Coordinate exact read-helper signatures with Task 2 before edits.

- [ ] Add failing latest-schema/owner-initialization tests and retain baseline output.
- [ ] Add append-only schema, indexes/constraints, clock integration and latest schema mirror; preserve historical mirrors.
- [ ] Implement atomic idempotent seed initialization and non-reusing owner sequence.
- [ ] Verify encrypted legacy geometry/groups/revisions/receipts unchanged, read-only startup, seed immutability, rollback/restart and FK integrity.
- [ ] Root reviews and commits the storage task with its tests.

### Task 2: Scoped service operations

**Files:** `server/services/note-board.js`, `note-group-store.js`, `note-groups.js`, `note-group-receipts.js`; existing group fixture/behavior tests as explicitly allocated.

**Interfaces:** preserve exported public service APIs; pass server-derived owner keys through internal layout/group reads, writes, expected-revision comparisons and receipt snapshots. Consume Task 1 helpers and tables. Shared deletion enumerates all owners plus seed.

- [ ] Independent test owner adds and runs RED `test/test-note-layout-isolation.js` using existing public services.
- [ ] Scope all projections, layout writes, membership transitions, allocation and cleanup; initialize inside authorized immediate write transactions.
- [ ] Scope receipt capture/match/replay/undo, explicitly fence historical receipts and preserve auth revalidation.
- [ ] Update old fixtures that assumed a globally shared board by selecting the intended principal; preserve privacy/conflict assertions.
- [ ] Verify service isolation, fractions, flags, group operations, same-owner conflicts, independent-owner concurrency and cross-owner deletion.
- [ ] Root reviews and commits the service task with registered regressions.

### Task 3: Actual authentication and browser transitions

**Files:** new `test/test-note-layout-isolation-context.js`, new `test/test-note-layout-isolation-full-app-browser.js`; client changes only if actual tests expose a missing boundary.

**Interfaces:** use existing human/device routes, pairing, temporary login and return flows. No client layout selector. Existing client auth epoch remains authoritative.

- [ ] Add RED real-cookie tests for two users/two devices, forged scope fields, foreign IDs, grants, temporary return/expiry and held writes.
- [ ] Add actual-app browser evidence proving personal/device geometry and group persistence across sign-in/out/reload, without cross-context retries or stale private DOM.
- [ ] Fix only demonstrated boundary issues while preserving the Wall allowlist and Calendar grants.
- [ ] Verify context and privacy regressions; root integrates tests and any bounded fix.

### Task 4: Migration/recovery and combined review

**Files:** recovery helpers/tests, `package.json`, OpenAPI only for actual contract changes, migration/recovery documentation and isolated QA evidence.

- [ ] Extend recovery snapshots to include every scoped table and counter; test forward, mutation-disabled recovery and forward restart.
- [ ] Independently review schema/identity isolation and all read/write call sites against the spec.
- [ ] Register regressions; freeze complete committed source and run canonical backend/browser suites plus relevant schema/migration checks.
- [ ] Run/report the project's global test gate and distinguish pre-existing unrelated failures.
- [ ] Produce a verified bundle and exact-source behavioral/migration evidence; retain deployment hold.
