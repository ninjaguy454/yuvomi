# Skipping an activity that references a shared order

A signed-in authorized manager can excuse one fixed-assignment recurring
activity whose rotation purposes belong to a Group-managed shared schedule.
The skipped activity and its unfinished actions become Skipped. Completed
actions, points already earned and recorded history remain. Skip awards no
new completion points.

The next activity uses exactly the next nominal recurrence date, including
an already overdue date. It follows the authoritative future purposes. Its order references
an existing scheduled snapshot or remains provisional until the Group
scheduler activates that period. Skip and its recovery never activate,
finalize, skip or advance the Group's order, and never reconcile another
child's activity or an already materialized future activity.

Eligibility verifies shared period/version/track ownership for concrete
references and the next authoritative nominal period. Independent consumer
rotations, retained independent decisions, round-robin assignment and
independent template assignment policies remain unsupported. Existing
child/device permissions, archive/status/revision checks and workflow/sync
exclusions continue to apply. A configuration or mode change while successor
materialization is pending keeps the committed Skip and receipt and pauses
recovery until its ownership is supported again.
Shared Skip also preserves both template assignment cursor stores, including
when an authorized future definition removes its shared purposes.

Synthetic coverage is registered in `npm run test:task-skip`: resolved,
finalized and provisional shared orders; earned step points; unaffected
siblings and shared snapshots; overdue nominal dates; idempotent retries;
pending recovery and mode boundaries; and concurrent Skip/completion/group
scheduler writers. The tests use only in-memory or disposable temporary data.
