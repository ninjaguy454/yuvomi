# Rotation consumers in Tasks and recurring Activities

One explicitly authored parent Activity owns a purpose. Its ordinary child Tasks and generated helper projections read the same resolved occurrence through ancestry. Sharing a Template, Group, title, or date never implicitly joins independent recurring series.

For a shared bedtime routine, create one recurring parent, add one Rotation purpose, choose the Kids Group and Rotating Order, then assign each participant action to its household member using the subtask assignee control. That control appears only while the parent has Rotation configuration. The existing recurrence engine copies those stable child definitions, assignments, skills and Optional settings into fresh work each night. There is no nested recurrence engine or per-child pointer.

The Task adapter uses the existing durable recurring-series ID as consumer identity, the stable purpose key, and registered recurrence occurrence provenance as the idempotency key. Nonrecurring Tasks and Workflow instances have their own explicit owner identities. Task completion settles the owner's Rotation occurrences before generating its successor; completing an individual child does not settle them. Expiration settles skipped, respecting the configured skip policy. Reopening cannot settle the same historical occurrence twice.

## Editing and snapshots

- **This occurrence only** creates an isolated exception Track for a changed purpose. The original link is retained as retired provenance and is settled once when its original owning Activity terminates. The recurring definition remains unchanged.
- **This and future occurrences** changes the durable series configuration. An already-resolved current occurrence keeps its snapshot and the save result explains that preservation. Eligible future definitions use the new configuration without rewriting historical order.
- An inactive Group or a pending earlier frontier leaves newly materialized Tasks intact with a visible “Rotation needs attention” state. An authorized user can explicitly resolve the current Task after addressing the Group/frontier. Reads never retry, advance or otherwise mutate Rotation state.
- An untouched materialized future Task accepts updated definitions while its Rotation is pending. Settling its registered predecessor automatically resolves missing future bindings in generation order, using the revised configuration and existing occurrence identity; it does not generate duplicate Tasks or advance again. Explicit recurrence reconciliation can recover the same pending work after interruption. Already-resolved future snapshots whose configuration/window would change are preserved and reported as exceptions. A future Task containing activity retains its concrete configuration; if that differs from the effective series definition, missing Rotation bindings resolve on an isolated exception Track rather than reverting the canonical Track.
- Current Task and card views show the shared order and the Task assignee's position. Task reads enforce `rotations.view` and omit private eligibility/history provenance. The Group's history provides the separately authorized audit view.

## Authored expressions

Activity Template fields using a configured purpose follow the existing typed variable syntax, for example `Take shower — {{shower_order.position}}`, or a derived numeric variable using `rotationPosition(shower_order, context.household_member)`. Resolution uses the canonical occurrence and each action's actual assignee.

Rotation-dependent title/description authorship is frozen with referenced definitions and inputs in the existing Activity snapshot and recurring-series JSON. Subsequent occurrences render from those frozen definitions and their actual resolved occurrence, not the current source Template or a previous Task's displayed number. Source action identity comes from Template checklist provenance and recurring action keys. A manual text edit detaches only that field. Literals retain their existing behavior.

An authorized occurrence override/recheck rerenders still-bound fields on active owner Tasks in the same database transaction. Historical Tasks and completed/expired child evidence retain their text. Any rendering failure rolls the override back. Rendering never completes Tasks or awards points.

## Focused validation

`test/test-task-rotation.js` covers four shared nights, independent Tracks, both series scopes, preserved progress, Template independence, manual policy, expiration and finalized-on-completion expiration, inactive Group recovery, stale writes and capabilities, participant assignment, per-person expression rendering, literal detachment, atomic override failure, and side-effect-free/read-redacted projections.

Task editor browser coverage adds desktop and mobile shared purpose/participant configuration and scope Cancel preservation. Existing series generation, edit, race, Optional lifecycle, supervision scheduling/refresh and permission-cache tests remain the regression gates. The checkbox mutation queue and touch/drag arbitration are unchanged; full-app card feedback is validated separately.
