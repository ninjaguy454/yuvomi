# Phase 2: Notes canvas and visibility

Status: requested scope approved; implementation not started. Any mandatory written-plan review is consolidated for later and must not interrupt Phase 1. Incorporates the user's approved card resizing and note visibility requirements and the Phase 1 four-capability contract. Phase 1's actual final commit is an integration prerequisite, to be supplied by parent before selecting an implementation baseline.

## Intent and release boundary

Make the existing Notes module a useful sticky-note canvas on phones, desktops, and paired displays. Preserve all existing note content and checklist behavior. Users resize individual cards, not the board. Add Private, Everyone, and Selected members visibility with server enforcement. Everyone means the current household, never anonymous/public access.

The release order is Phase 1 paired Notes, Phase 2 canvas/privacy, Phase 3 open tasks. No further live deployment until the parent explicitly lifts the hold after the user returns. Background implementation may use isolated test containers after Phase 1 finishes. Never modify live household data, device grants, configuration, services, or the urgent worker's checkout.

Use Node >=22, vanilla JavaScript ES modules, existing CSS tokens/components, and existing vendored frontend utilities. No framework, bundler, runtime CDN, or new frontend package. Migrations are append-only; the test schema must match. No new grants are activated by default.

## Existing foundations

Inspected `C:/Users/Duaner/Documents/Codex/2026-10-03/task/vidamia-task-layout`; its branch ref records `f2352a51012a8415d0b0f747450140f6b1cb6812`. Guidance: `CONTRIBUTING.md`, `DESIGN.md`; no applicable AGENTS.md/SKILL.md found in inspected ancestry/source directories.

- `public/pages/notes.js`: existing colors, cards, search, creator filter, reader/editor, optimistic checklist UI.
- `server/routes/notes.js`: CRUD, pin, atomic line-level checklist changes; no note audience model today.
- `server/services/document-access.js`: creator plus explicit-recipient visibility precedent.
- `server/services/visibility.js`: private creator-only semantics, without automatic admin bypass.
- `server/routes/dashboard.js`, `server/services/wall.js`, `server/services/search.js`: additional Notes exposure paths. Search currently restricts notes to their creator.
- `server/services/change-stream.js`, `device-app.js`, `device-write-context.js`: payload-free revisions, distinct device streams, session/permission revalidation and write leases.
- `public/utils/task-card-drag.js`: explicit touch handles preserve native scrolling.
- `server/db.js`: existing Notes updates also change updated_at and rebuild search entries; therefore layout must live separately.

## UI and layout

Retain the Notes route, app shell, search, creator filters, reader/editor, pins, Markdown, checklist controls, and muted note palette. Add an explicit move handle and resize handle per card and Organize on grid in the toolbar. Moving/resizing must not activate a checkbox or open the editor. Ordinary touch movement scrolls; drag begins only from its handle, following the existing touch conventions. Escape cancels a gesture; pointer cancellation and identity changes dispose it.

The logical board uses 12 columns, with nonnegative integer x/y and positive integer width/height in grid units. Width is bounded to 12 and x+width to 12; card minimum dimensions must keep its header and controls usable. Renderer converts units through theme spacing and measured column width. Board height grows with card extents; the user cannot resize it. Cards have independent scrollable previews and an Open action for full content.

Use shared server-persisted geometry per note. Wide screens use saved coordinates. Narrow screens deterministically reflow authorized cards into available columns, preserving saved order and clamping rendered widths; this projection does not write back during viewport changes. Compact-screen numeric move/size controls edit the canonical grid values directly with a preview; they do not infer canonical coordinates from a reflowed position. Every device can change individual card dimensions through these controls. The canvas renderer may additionally support direct handles where their mapping is exact. Orientation changes never persist geometry automatically.

Keyboard/tap alternatives: Move controls, size controls, and Organize on grid. Provide a compact ordered view where every visible note remains reachable regardless of saved geometry. Search/filter changes never persist a new arrangement. New notes appear in a free visible grid slot. Missing legacy layouts get deterministic defaults from pinned status, updated_at, and ID; avoid data writes on GET.

Organize on grid packs only currently authorized, filtered notes in stable pinned-first order, preserving chosen dimensions. It submits one batch with each affected layout revision and commits all or none. No hidden note IDs, rectangles, counts, or recipient metadata are returned to fill gaps. Filters and phone reflow remove hidden-card gaps; geometry is not a source of authorization.

## Access model

Add `notes.visibility` with strict values `private`, `all`, `selected`, default `all` for existing and new notes. Add `note_access(note_id,user_id)` with unique composite key and cascading note deletion. Creator access is implicit. Selected mode requires at least one valid recipient other than the creator; switching away clears stale access rows transactionally. Reject invalid audience values and invalid/non-household/guest/worker recipient IDs. Do not silently normalize invalid input to Everyone.

Create one `server/services/note-access.js` authority for both SQL filters and action checks. Human access requires the Notes module grant plus creator/all/selected visibility. Private is creator-only; administrator role alone does not bypass it. Existing content collaboration remains possible for visible users with Notes write permission, but only the human creator can change audience/recipient membership. Server checks the current note, not client claims about ownership. Non-visible IDs return the same not-found behavior as nonexistent IDs.

Paired displays inherit Phase 1's exact independent View/Create/Edit/Delete controls. Do not rename, merge, or bypass them. Moving, resizing, auto-organizing, pinning, and checklist changes are edits and require Edit plus View. Create permits only creating a new note; it never authorizes updating/deleting it later. Delete requires its independent grant. Keep Phase 1's precise read dependency rules once reviewed, without enlarging them.

Device-principal notes are Everyone only. Device creation preserves Phase 1's creator/source attribution model and never fabricates a human author. A device cannot set Private/Selected, name a human creator, or alter recipients. A real temporary human session sees only that authenticated person's notes; its return/expiry restores the device's Everyone-only projection. A claim identity picker is not authentication and has no Notes effect.

The desired kids display profile is View+Create allowed, Edit+Delete denied. This is a test fixture and configuration proposal only: the exact production device has not been identified/authorized here. Do not change any actual device grants.

## Persistence and concurrent updates

Add integer `notes.revision` for substantive content/title/color/pin/audience/recipient changes. Add `note_layouts(note_id PRIMARY KEY, x,y,width,height,revision)`; its revision advances only on geometry changes. Layout writes do not alter note content, updated_at, or search ranking. Layout rows cascade with notes; never reuse a deleted note's identity.

Suggested API contract, finalized against Phase 1 routes:

- `GET /notes`: authorized notes, each with current content revision, authorized controls, and layout (stored or deterministic default).
- `PUT /notes/:id`: submitted fields plus `expected_revision`; preserve existing validation and reject stale edits with 409.
- Existing `/pin`, `/check`, DELETE: current access rechecked. Keep checklist `line/checked/expect` operation-level semantics so independent line toggles survive. Audience loss denies pending checklist writes. Add revision checking where an operation could overwrite a newer definition.
- `PATCH /notes/:id/layout`: `{expected_layout_revision,layout:{x,y,width,height}}`; accept only geometry, require edit authorization, and check expected revision atomically. Use revision 0 for a missing layout and guarded insert.
- `PATCH /notes/layout`: `{items:[{note_id,expected_layout_revision,layout}]}`; distinct IDs, bounded batch, no partial writes. Literal routes register before `/:id` routes.

For content/audience save, validate access and revision inside one immediate transaction before changing the note, recipients, or layout. Full content drafts remain in the editor after 409; never auto-overwrite the server's version. Geometry has a per-note serial optimistic queue; coalesce local movement, persist on drop/resize end, roll back failed optimistic changes and offer retry. Unrelated cards do not contend through one global revision. No durable browser cache of restricted notes.

Add a Notes change clock for content, access, deletion, and layout changes. Reuse payload-free invalidation and the existing separate device authorization path; do not force device principals through the human session stream. Clients re-fetch authorized data, patch cards without disturbing focus or active editing, and use context generations to reject late responses. Revocation/logout/temporary expiry immediately clears restricted DOM, modals, drafts, in-memory caches, requests, and gestures. Reconnect reauthorizes before returning data. Responses are private/no-store under existing API conventions.

## Complete privacy boundary

Use the same access service in Notes routes, layout operations, Dashboard note previews/counts, legacy Wall projections, global search, paired adapters, and any registered Notes MCP/tool routes found during implementation. Apply visibility before LIMIT/count/serialization. Search should find all and only authorized notes, replacing its inconsistent owner-only predicate. Pinning does not make a note public. A selected recipient list is only exposed where the viewer needs it for authorized audience management.

Household isolation follows the existing deployment database boundary: never accept a client household/database selector. All member IDs resolve in the same database and against real household membership. Do not add cross-household lookup infrastructure.

## Migration and privacy-preserving rollback

Append schema changes only after Phase 1's actual migration head; reserve no version number now. Existing notes remain Everyone with unchanged content, authorship, color, pin, timestamps, and checklist state. Mirror the schema and triggers in test fixtures. Verify populated encrypted rehearsal, foreign keys, integrity, old rows, migration history, and a no-op second startup using synthetic data.

Phase 1/older images cannot enforce new audiences and must never serve this database after restricted notes are possible. Prepare a rollback-compatible image from the Phase 2 code that retains audience schema, access filters, session cleanup, and all restricted-note protections while falling back to the old masonry presentation. Its tests must prove private/selected notes remain hidden across API/dashboard/Wall/search/device surfaces. If that image is unavailable or fails, stop the affected app/Notes exposure rather than starting Phase 1. Do not restore an old database over new household writes as an automatic rollback.

The deployment runbook must record this barrier alongside exact forward/rollback image digests. This is an operational gate; an old image cannot be made safe merely by hiding navigation or disabling the new client UI. Also test an old client against the new server: stale edits cannot reset audience, and unknown fields/default omissions cannot widen visibility.

## Acceptance

All-device board; real individual card resizing; reload persistence; keyboard/tap alternatives; every note reachable at phone/desktop/touch sizes, zoom and orientation changes; no mutation from viewing or filtering; exact four-grant device matrix; no Create-to-Edit/Delete escalation; full audience matrix and all exposure paths; two-client content/layout conflicts; line-level checklist independence; auth-context race handling; preserved content and permissions after encrypted migrations; privacy-safe rollback. The detailed executable sequence is in the Phase 2 plan.
