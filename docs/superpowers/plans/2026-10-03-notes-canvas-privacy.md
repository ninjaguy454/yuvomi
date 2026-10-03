# Notes Canvas and Privacy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not delegate additional agents unless separately authorized.

**Goal:** Deliver the Phase 2 Notes canvas, individual card sizing, and enforced audiences without weakening the Phase 1 device capability contract.

**Architecture:** Centralize Notes access and persistence behind shared services used by human/device adapters and all preview/search consumers. Persist geometry independently from content, and render one responsive, accessible canvas using the existing Notes editor. Release with a privacy-safe rollback image.

**Tech Stack:** Node >=22, vanilla browser ES modules, Express, existing SQLite implementation, node:test, existing Puppeteer browser harnesses.

**Spec:** [Phase 2 design](../specs/2026-10-03-notes-canvas-privacy-design.md)

## Global Constraints

- The release order is Phase 1 paired Notes, Phase 2 canvas/privacy, Phase 3 open tasks.
- No further live deployment until the parent explicitly lifts the hold after the user returns.
- Background implementation may use isolated test containers after Phase 1 finishes.
- Never modify live household data, device grants, configuration, services, or the urgent worker's checkout.
- Use Node >=22, vanilla JavaScript ES modules, existing CSS tokens/components, and existing vendored frontend utilities.
- No framework, bundler, runtime CDN, or new frontend package.
- Migrations are append-only; the test schema must match.
- No new grants are activated by default.

## Review Focus

- A View+Create-only child display must not mutate even the note it just created (Task 1/2).
- An older browser submitting missing audience fields must not republish a private note (Task 2).
- A cached personal response arriving after temporary sign-in expires must never appear on the shared board (Task 3).
- Search/count/legacy Wall shortcuts must not reveal restricted note existence (Task 2/3).
- Narrow-screen reflow and rollback to masonry must retain every note and all privacy protection (Task 4/5).

## Preparation and evidence rules

Use a new independent clone under this workspace after the parent supplies the actual Phase 1 commit. Do not run `git worktree add` against the shared checkout. Read its exact four-capability implementation and tests first; names/adapter file placement in this plan must be reconciled to that commit without weakening the contract. No production .env, database, volume, device cookie, or credential is copied.

Every Node command below runs in that clone with DB_PATH set before imports, using `:memory:` or a unique synthetic database path. Set a test-only SESSION_SECRET and isolated HOME-equivalent application paths if required by the harness; do not repurpose system HOME variables. Browser fixtures use their own loopback server/port and temporary profile. Encrypted tests use generated test keys. Reuse the repository's tmp-db fixture conventions.

Record baseline failures before editing. A known failing baseline is not a green candidate; record exact baseline/candidate evidence. Register every new suite in package.json and run suite-chain/db-isolation guards. Each task ends with a scoped commit in the isolated branch, never shared checkout commits.

### Task 1: Schema and single Notes authority

**Files:** Create `server/services/note-access.js`, `server/services/note-board-schema.js`; modify `server/db.js`, `server/db-schema-test.js`, `package.json`; tests `test/test-note-access.js`, `test/test-note-board-migration.js`.

**Interfaces:** Produce `noteVisibleSql(alias='n', viewerParam='viewerId') -> SQL`, `noteCapabilities(d,principal,note) -> {view,create,edit,delete,manage_visibility}`, and `assertNoteAction(d,principal,note,action) -> void`. Principal remains the existing human request/device representation. Schema produces visibility, recipient rows, note revision, independent layout revisions, and a Notes change clock.

- [ ] Write failing access tests: creator can read private; unrelated admin cannot; selected member can read selected; another member cannot; device sees only all; independent View/Create/Edit/Delete combinations; creator does not override a device's missing Edit/Delete.
- [ ] Write migration tests asserting old note content/title/color/pin/creator/timestamps are unchanged, old visibility becomes all, layouts are absent until edited, and synthetic encrypted migration then restart applies changes once.
- [ ] Run `node --experimental-sqlite --test test/test-note-access.js test/test-note-board-migration.js`; confirm failures identify missing behavior.
- [ ] Implement the authority and additive migration after Phase 1's final migration number. Strictly validate audience enums and household recipients; preserve Phase 1 attribution. Use dedicated schema helpers if its schema mirror convention requires them.
- [ ] Run those tests plus `npm run test:migrations-append-only` and `npm run test:schema-mirror`; inspect output and commit `feat: add note visibility and board persistence schema`.

### Task 2: Atomic routes and all visibility consumers

**Files:** Create `server/services/note-board.js`; modify `server/routes/notes.js`, Phase 1's Notes device adapter, `server/routes/dashboard.js`, `server/services/wall.js`, `server/services/search.js`, `server/openapi/paths/notes.js`, and any existing Notes MCP adapter located by source search. Tests `test/test-note-board-routes.js`, `test/test-note-privacy-surfaces.js` plus existing Notes route/checklist tests.

**Interfaces:** `readNoteBoard(d,principal,filters={}) -> {notes}`; `updateNote(d,principal,id,body) -> note`; `setNoteLayout(d,principal,id,{expected_layout_revision,layout}) -> layout`; `setNoteLayouts(d,principal,{items}) -> layouts`. Layout is `{x,y,width,height,revision}` with 12-column bounds. Authority from Task 1 is used on every call. IDs/revisions use existing integer validation conventions.

- [ ] Write failing tests for direct-ID read/edit/pin/check/delete, audience owner-only changes, invalid recipients, guest/worker IDs, old-client missing audience fields, invisible IDs indistinguishable from absent, and Create-only device edits/deletes of its own new note.
- [ ] Write geometry tests: missing layout revision 0 creates once; stale revision yields 409; content untouched; unauthorized batch member rejects the whole batch; duplicate IDs and negative/oversized/nonfinite coordinates fail; delete cascades layouts/access rows.
- [ ] Write complete-payload tests for dashboard preview/count, Wall, search, paired adapters and discovered tool consumers. Verify filtering before counts/LIMIT and all/selected/private semantics for each principal. Use a uniquely identifiable secret string in fixtures and assert it never appears in unauthorized serialized responses.
- [ ] Run `node --experimental-sqlite --test test/test-note-board-routes.js test/test-note-privacy-surfaces.js` and confirm the intended failures.
- [ ] Implement routes using immediate transactions for access+revision+mutation, preserve operation-level checklist semantics, and replace each consumer's visibility predicate. Do not expose recipient lists to viewers who cannot manage visibility. Make geometry updates independent of note updated_at/search triggers.
- [ ] Run new suites plus `npm run test:notes-routes`, `npm run test:notes-checklist`, `npm run test:notes-reader`, search permissions and dashboard permissions suites, then commit `feat: enforce note audiences across routes and projections`.

### Task 3: Live invalidation and identity safety

**Files:** Create `server/services/note-changes.js`, `public/utils/note-board-state.js`; integrate `server/routes/notes.js`, Phase 1 device adapter, `public/pages/notes.js`, existing client context/session utilities. Tests `test/test-note-board-concurrency.js`, `test/test-note-board-context.js`.

**Interfaces:** `noteChangesStream(req,res)` uses Task 1's clock and existing human stream conventions; devices use the established device stream adapter. Client board state exposes `beginContext(contextKey)`, `applySnapshot(contextKey,snapshot)`, `queueLayout(noteId,layout)`, and `dispose()`; queue acknowledgements belong to their originating context.

- [ ] Write failing tests for two clients changing different cards, two conflicting changes to one card, content vs geometry independence, two checklist lines, visibility reduction during save, expired temporary session during a held response, stream reconnect after permission reduction, and revoked device replay.
- [ ] Run `node --loader ./test/test-browser-loader.mjs --experimental-sqlite --test test/test-note-board-concurrency.js test/test-note-board-context.js` and confirm intended failures.
- [ ] Implement payload-free stream invalidation and context-bound client queues. Emit/refetch current authorized state; no hidden data in stream events. Serialize same-card updates, preserve drafts on 409, cancel/clear restricted state on context switch, and reuse server write leases.
- [ ] Run new tests and Phase 1 device write/client/session/privacy suites using their registered commands. Commit `feat: synchronize note changes within current auth context`.

### Task 4: Canvas, audience editor, accessible card interactions

**Files:** Create `public/components/note-board.js`, `public/utils/note-board-layout.js`; modify `public/pages/notes.js`, `public/styles/notes.css`, existing locale catalogs and static asset registration if needed. Tests `test/test-note-board-layout.js`, `test/test-note-board-browser.js`.

**Interfaces:** `projectNoteLayout(notes,{columns}) -> positionedCards`, `organizeNoteLayout(notes) -> layoutChanges`, `bindNoteBoard(root,{notes,capabilities,onLayout,onOpen,onCheck}) -> dispose`. Existing editor remains responsible for title/content/color and new audience fields; callbacks invoke Tasks 2/3.

- [ ] Write failing pure-layout assertions for deterministic legacy defaults, 12-column bounds, filtered/hidden cards, mobile reflow without writes, stable organize order, existing card dimensions, and reachable extents after extreme valid positions.
- [ ] Write real-browser scenarios for individual move/resize/reload, no board resize control, phone orientation and 200% zoom, touch scroll versus handle drag, keyboard/tap move/size/organize, Escape/pointer cancellation, full-content opening, light/dark contrast, and no Edit controls on View+Create-only devices. Exercise all three audience choices and visible audience labels.
- [ ] Run `node --test test/test-note-board-layout.js test/test-note-board-browser.js` with isolated browser fixtures; confirm expected failures.
- [ ] Implement the canvas and explicit controls using app tokens and touch conventions. Compact projection never persists automatically. Compact numeric move/size controls edit canonical values directly with preview; avoid guessing an inverse mapping from a reflowed position. Retain a compact ordered fallback. Audience editor is creator-only; device composer is Everyone-only.
- [ ] Run new tests, existing Notes reader/Markdown/checklist tests, theme/mobile-scroll/frontend audit checks affected by the change. Capture desktop, phone, paired-display, light/dark, and keyboard focus evidence. Commit `feat: add responsive accessible Notes canvas`.

### Task 5: Integration, rollback artifact, release handoff

**Files:** Add release report and rollback runbook under `docs/`; add `test/test-note-privacy-rollback.js`; modify only isolated test/container fixtures needed for this candidate.

**Interfaces:** Forward image and a separately identified rollback image both satisfy Task 1/2 privacy contracts. Rollback image uses masonry presentation without removing privacy schema/read filters. Record exact source commit and immutable image digest for each.

- [ ] Write failing rollback tests that seed private/selected notes, run the privacy-preserving masonry candidate, and assert all unauthorized surfaces remain empty of secret IDs/text/counts. Test legacy browser requests and device expiry against this candidate.
- [ ] Build both images in uniquely named isolated test containers with synthetic volumes; no live mounts. Run `node --test test/test-note-privacy-rollback.js` and the populated encrypted migration/restart rehearsal.
- [ ] Run registered Phase 2, Notes, device, permissions, search, dashboard, schema and isolation gates. Run the repository full suite where the isolated environment supports it; record baseline failures separately, with exact commands/output. Do not run competing resource-heavy tests while Phase 1 rollout is active.
- [ ] Inspect migration preservation, privacy payload evidence, browser screenshots, and race outcomes. Fix issues and repeat only affected checks plus required gates. Perform final branch review against the spec.
- [ ] Commit the release report; return exact candidate/rollback commits, digests, results, limitations, and the explicit rule that Phase 1 may not serve a database containing restricted notes. Do not deploy, push live configuration, or activate capabilities. Parent owns the release hold.
