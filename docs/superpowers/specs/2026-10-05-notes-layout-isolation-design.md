# Independent Notes layouts and group membership

The user approved independent personal-user and paired-device layouts, including independent group membership: grouping two notes on a phone must leave the Wall display's structure unchanged. Implementation is authorized; deployment remains held for combined behavioral and migration review.

## Identity and behavior

Resolve the effective Notes principal server-side. An authenticated human uses `human:<user id>`; an anonymous paired display uses `device:<household device id>`. A temporary paired sign-in uses the human layout, and return/expiry restores the device layout. Device credential IDs, context keys, permission revisions, viewport and client-supplied fields never select persistent layout ownership. Existing authentication-context checks remain separate security fences.

Each owner has independent geometry, canvas position locks, top-layer flags, layout revisions, groups, membership, order, group revisions and structural receipts. One human's ordinary phone and desktop sessions share that human's layout. Different devices remain independent. Content, note authorship, audiences, recipient lists, content revisions and the separately labeled Show on Dashboard setting (`notes.pinned`) retain existing semantics. Canvas pinning means `position_locked`.

## Storage and initialization

Append migration 10053. Preserve historical migrations and existing layout/group/receipt tables. The legacy layout and group tables become a frozen seed, never a target for ordinary new arrangement commands. Add `note_board_owners(owner_key,next_group_id)`, `note_board_note_layouts`, `note_board_groups`, `note_board_group_members`, and `note_board_group_receipts`. Scope note-layout and membership uniqueness by owner plus note; group identity and group/member foreign keys by owner plus group ID. Receipts include owner and their existing authentication-bound principal key.

Uninitialized owners read the frozen seed through existing authorization/visibility projection without writing during GET. Their first authorized structural mutation copies the seed atomically inside the existing immediate transaction. Preserve fractional coordinates, sizes, flags, group IDs/order and revisions so the already-read expected snapshot remains valid. After initialization every lookup and mutation uses that owner's tables. New owners never inherit another owner's later changes. Persistent per-owner group counters prevent ID reuse within an owner.

Shared content deletion necessarily removes that note from all layouts. Discover all affected groups before deletion; repair seed and every initialized owner's group independently, preserving singleton anchor/flags and monotonic revisions. Do not serialize other owners or hidden survivors to the deleting actor.

Legacy receipts remain unchanged and cannot execute pre-isolation undo. A matching legacy retry may only be acknowledged after current authorization, with undo unavailable; it must not execute twice or restore shared structures. Unknown/stale legacy operations conflict safely. New receipts, snapshot capture/matching, replay and undo are owner-scoped and retain permission/context revalidation.

## Authorization and recovery

Keep existing view/edit requirements for arrangement and grouping. Devices remain Everyone-only with separate Notes grants; admins gain no private-note bypass. Reject ownership selectors in mutation bodies and do not use query/header selectors. Foreign-owner group and receipt identifiers expose no foreign state. Hidden membership is filtered before projection and does not grant structural authority.

Keep existing client authentication teardown, request abortion, fresh board reads and temporary-session fences. Do not broaden legacy Wall routes or Calendar edit grants. Recovery retains the new backend/schema and owner data; use the existing mutation-disable switch rather than an older writer. Restarting or reapplying migration must not reseed initialized layouts.

## Acceptance evidence

Prove two users and two devices can independently move, resize, pin, layer, organize, group, reorder, join, transfer, extract and undo the same shared notes. Same-owner stale writes conflict; different-owner writes do not create false conflicts. Shared content updates retain their own CAS. Verify real temporary sign-in/return/expiry, held requests, visibility loss, forged scope input, encrypted migration preservation, transaction rollback, restart and forward/recovery/forward behavior. Run combined canonical Notes/group/acceptance suites and report existing unrelated global audit failures explicitly. No live household mutation or deployment is part of this implementation task.
