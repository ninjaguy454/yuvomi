# Rotation Groups: implementation audit and contract

Starting source: `cf4b5e2de9f0f7e8b1fd6523d6ec397c0fa12bd4`. Local implementation only; no publication or deployment.

## Audit before implementation

There is no existing reusable, ordered household membership Group. Existing `rotation_group` text fields are cursor aliases, not Group identities. Preserve these values and their provenance through a compatibility adapter; do not infer membership from their names.

- Task migrations 10000/10001 provide per-Task ordered members and synchronized recurring assignment cohorts (`rotation_group`, slot and cycle). This is legacy assignment scheduling, not the new Group model.
- Activity assignments use `activity_rotation_state` and `assignment_rotation_state`. Their eligibility resolver already uses Skills/proficiency and explained Presence/Availability. Reuse it.
- Meal Plans have stable rule/slot keys, independent role and travel-context scopes, assignment snapshots, and retry identity. Three Meal round-robin implementations duplicate selection. Their pending travel reconciliation may rewind a proven untouched cursor tail; retain that compatibility behavior without rewriting completed history.
- Recurring Tasks own versioned series definitions and stable occurrence/action provenance. Source templates are copied configuration, not live parents.
- Task Workflows create a parent occurrence and child Activity Tasks, but currently lack retry identity. Workflow preview is non-persistent. Add explicit request identity before introducing rotation writes.
- Variables have a shared typed expression engine. Rotation expressions must hydrate trusted domain values and remain read-only; interpolation must never resolve or advance a Track.
- The household is currently one database, not a multi-tenant `households` model. Rotation records use a local household scope rather than inventing parallel household accounts.

## Model and decisions

A Group owns ordered stable memberships only. A Track owns configuration, revision and next membership identity for one consumer/purpose. An Occurrence snapshots resolution, eligibility explanations, original/overridden results and exactly-once advancement. Group edits never advance a Track or rewrite history.

Tracks use `(household_key, consumer_type, consumer_id, purpose_key)` identity, independent of Group identity. Related child Tasks share a rotation only through an explicit owning parent Activity/Workflow occurrence and its durable provenance; never through title, Template identity, Group name or a guessed calendar date. Individual independent series remain independent.

Strategies: `round_robin`, `rotating_order`, `fixed_order`. Advancement policies: `manual`, `on_finalized`, `on_completed`. Skips do not advance by default. Overrides preserve the original result. By default Rotating Order advances to the effective planned second member; Round Robin continues after the effective selected member in the configured ring. Subsequent order uses the Group baseline starting at that next identity, so an occurrence override does not permanently reorder the Group. Actual completion timing never controls the pointer. Setting `override_affects_next=false` retains the original planned next member instead. Finalized historical orders cannot be edited.

Only one unresolved advancement frontier is allowed per Track. Repeated resolution of the same occurrence returns the stored snapshot. A different occurrence cannot consume an unsettled pointer. Consumers must finalize/skip the previous occurrence according to policy; a passed date alone is not advancement. Fixed order has no pointer advancement.

Membership changes preserve the next stable membership when present. If it is removed, scan forward through the previous ring for the next surviving identity; newly added members participate in their configured position without resetting other Tracks. Removed memberships remain retained for provenance. Deleted/non-household users are ineligible for new resolution, while historical snapshots retain their names/identity.

Eligibility behavior is explicit: `skip_unavailable` selects from eligible members without removing anyone from the Group; `keep_position` leaves the result unavailable when the next member cannot participate. Zero eligible members produces one durable empty provisional result and no advancement. An authorized recheck may resolve that same occurrence when facts change. Consumer-specific eligibility is marked in persisted provenance: public recheck cannot bypass Meal participation/role rules and must return through the owning consumer. Deactivation blocks new resolutions while preserving existing occurrences.

Administrative correction is separate from an occurrence override. It changes the Track's next stable membership, records previous/new state, actor and optional reason, and increments a correction generation. An older pending occurrence may still settle, but cannot overwrite that explicit correction. Three-step preview is hypothetical after successive advances and performs no writes.

## Canonical service contract

`server/services/rotation.js` is the only new strategy/state engine. All functions accept an existing database handle and participate in its transaction.

- `listRotationGroups(d, {includeInactive=false})`, `getRotationGroup(d, id)`.
- `saveRotationGroup(d, input, {id=null, actorId, expectedRevision})`: name, description, active, `member_ids` in order.
- `configureRotationTrack(d, input, {actorId=null, trusted=false})`: snake-case configuration `{consumer_type, consumer_id, purpose_key, label, group_id, strategy, advance_policy, advance_on_skip, override_affects_next, eligibility_behavior, eligibility, expected_revision}`. Internal materializers may use `trusted:true` only after their consumer permission boundary. Existing identical configuration is a no-op; changes require expected revision.
- `getRotationTrack(d, id)`, `findRotationTrack(d, {consumer_type, consumer_id, purpose_key})`, `inspectRotationTrack(d, id)` (read-only next preview), `rotationHistory(d, trackId)`.
- `previewRotation(d, trackOrConfig, {context={}, eligibleUserIds, eligibilityExplanations}={})`: no writes, including no cursor/group/track creation.
- `resolveRotation(d, trackId, occurrenceKey, {context={}, eligibleUserIds, eligibilityExplanations, expectedTrackRevision, actorId=null}={})`: durable idempotent provisional snapshot; no advancement.
- `getRotationOccurrence(d, id)`: includes `order` (member snapshots with `id`, `membership_id`, `display_name`, one-based `position`), `member_ids`, `selected_member`, `original_order`, strategy/configuration snapshot, revision, status and advancement outcome.
- `finalizeRotation(d, occurrenceId, {outcome='finalized', expectedRevision, actorId=null, trusted=false, manual=false}={})`: outcomes `finalized`, `completed`, `skipped`; advances once according to the snapshotted policy. `manual:true` explicitly requests manual-policy advancement. Repeated identical terminal requests return the stored result without another write. Trusted lifecycle callers already passed consumer authorization; public callers need the Rotation advance capability.
- `skipRotation(d, occurrenceId, options)` delegates to finalize with skipped outcome.
- `overrideRotation(d, occurrenceId, {member_ids, expected_revision, actorId})`: only provisional occurrences; intersects the snapshotted eligible members with fresh canonical eligibility and records actor/time/original result. A consumer-specific eligibility snapshot must return through its owner rather than bypass its rules through this generic operation.
- `correctRotationTrack(d, trackId, {next_member_id, expected_revision, reason, actorId})`: explicit, audited administrator correction; does not rewrite occurrence history.
- `refreshRotationOccurrence(d, occurrenceId, {expected_revision, actorId})`: authorized recheck of an unavailable provisional result. Trusted consumer calls additionally supply freshly resolved `eligibleUserIds`, explanations and context.
- `previewRotationSequence(d, trackId, {count=3})`: bounded pure simulation of subsequent advances.
- `orderedRotationSelection({memberIds, eligibleIds, nextMemberId, strategy='round_robin'})`: pure baseline scan shared with legacy adapters; returns ordered IDs and next identity. Legacy adapters may retain their old persistence keys and travel-tail reconciliation; they must not duplicate the selection algorithm.

Public configuration/lifecycle/history APIs enforce separate `rotations.view/manage/configure/override/advance/correct/history` capabilities. Admins retain full access; restricted members do not gain privileges from age. Integration-token routes also require the existing Family module scope. Live notifications reuse the authenticated payload-free change stream and a Rotation version clock; Task consumers receive normal Task invalidation.

Activity/Workflow reusable configuration is stored as `rotation_bindings_json` arrays on templates and Tasks and copied into series snapshots. Each entry has stable `purpose_key`, label and the Track configuration above. Runtime Task bindings link to durable Track/Occurrence IDs in separate provenance rows. Expressions use typed references, never client-supplied snapshot objects as authority.

Migration 10039 is additive to deployed 10038. No deployed migration is edited. Migration rehearsal, concurrency/idempotency tests, eligibility/permission tests, typed expression/workflow/Meal compatibility tests, and focused desktop/touch browser checks are required before the local candidate is considered complete.

The migration creates Group/Track/Occurrence/event/binding/idempotency tables and adds nullable Meal references plus empty configuration arrays. Existing variable type CHECK constraints are widened through a preserving rebuild; rows, identities, foreign-key targets, explicit indexes and triggers survive. No old cursor aliases are guessed into Groups. Legacy Activity and Meal adapters retain their stored keys and historical reconciliation rules but share the canonical pure selection algorithm. Legacy synchronized Task assignment cohorts remain their established calendar-assignment model; they are not silently reinterpreted as reusable Groups.
