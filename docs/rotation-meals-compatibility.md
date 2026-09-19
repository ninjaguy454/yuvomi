# Meal Planning adoption of Rotation Groups

The Meal implementation preserves released configuration and provenance. Legacy `rotation_group`, `cook_rotation_group`, and `supervisor_rotation_group` text values are cursor aliases, not user-managed membership Groups. They remain stored unchanged. No membership is guessed from those strings, and no existing meal or assignment snapshot is backfilled or rewritten.

## New explicit Groups

Meal Plan chooser, cook, and supervisor settings now accept explicit reusable Rotation Group references. Their selection is the intersection of Group membership and the existing Meal Planning context, role Skills, Availability, and Presence resolution. An empty eligible Group never falls back to an unrelated household member.

Each role receives an independent durable Track identified by the Meal Plan, its stable reusable slot identity, the planning scope, and role. Different weekdays of one authored slot share that slot's Track; separate slots, roles, plans, travel contexts, home-split contexts, and Activities do not share advancement merely because they reference the same Group.

The existing Meal Plan generation transaction calls the canonical Rotation service, stores its occurrence reference alongside existing Meal assignment provenance, and finalizes the allocation once. This matches the established Meal chooser allocation boundary: a turn is allocated when the dated meal is generated, including future planning, not when somebody eats or completes a generated Task. The editor explicitly explains that boundary. A skipped dated meal creates no allocation and consumes no turn.

The existing Meal GET week/status surfaces may materialize scheduled output before projecting it. This pass preserves that established consumer behavior; Rotation preview, inspect, and history themselves never materialize or advance anything.

## Compatibility and history

All duplicate Meal round-robin selection loops delegate to the canonical pure strategy helper. Legacy alias cursors and their before/after snapshots remain compatibility persistence because established late-travel reconciliation can rewind a proven untouched pending cursor tail. That adapter has no separate selection algorithm.

New explicit-Group snapshots are finalized allocation history. Later travel changes can reconcile a pending Meal's current chooser using the existing audited Meal reassignment path, but do not rewind the finalized Rotation Track or rewrite its original snapshot. Existing manual Meal reassignment likewise changes the consumer's current assignment and Meal audit, not the finalized canonical plan; generic Rotation override is intentionally unavailable on finalized allocation history. Current Meal assignment provenance and original Rotation resolution therefore remain distinguishable. Completed/user-modified Meal evidence retains its existing protections.

Editing membership within the same Group preserves the Track's next stable membership identity. Explicitly selecting a different Group starts that newly chosen Group's configured baseline. Neither operation rewrites prior Rotation Occurrences.

## Unavailable allocations

An inactive Group or an unsettled prior rotation leaves the new Meal unassigned with a durable explanation in its existing provenance; it does not silently choose someone outside the Group or roll back the entire planning range. An initial empty result remains unresolved without consuming a turn. Subsequent dates remain unassigned until the blocking occurrence is explicitly resolved or skipped.

An authorized administrator can use **Recheck rotations** on the Meal. This reevaluates its current canonical Meal eligibility through the owning consumer, resolves or refreshes the same occurrence, commits it once if someone qualifies, and updates chooser/cook/supervisor responsibility through existing Meal records. Ordinary fallback processing cannot bypass an unresolved Rotation. Generic public refresh must reject consumer-specific eligibility snapshots rather than drop Meal context or role restrictions.

## Focused validation

Evidence logs are under `.qa/rotation-groups-20260919/`.

- `test/test-rotation-meals.js`: shared Shower/Dinner membership with independent Tracks, independent chooser/cook/supervisor roles, stable weekday slot identity, idempotent generation, revision/history preservation, permissions, role Skills, transactional rollback, home/travel independence, audited late-travel projection reconciliation, Group membership edits, skips, inactive Groups, unresolved cohorts, and authorized repair.
- `test/test-rotation-meals-ui.js`: actual Meal editor module at desktop and touch viewport widths; Group selectors, per-role payloads, and preserved legacy aliases.
- Compatibility: `test/test-meal-plans-domain.js`, `test/test-phase4-assignment-meals.js`, `test/test-phase5-coordination.js`, `test/test-planning-context-travel.js`, `test/test-meals-routes.js`, and `test/test-meal-week-model.js`.

No production access, publication, or deployment occurs in these tests.

Final focused Meal gate: **146/146 passed**, zero failures/skips (17 new service cases, 2 desktop/mobile browser cases, 127 existing compatibility cases). Log: `.qa/rotation-groups-20260919/meal-final-gate.log`. Browser fixture uses the actual Meal editor module and synthetic API data; no real household data is used.
