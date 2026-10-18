# Close without completing remaining subtasks

Activity Details keeps **Completed** and adds **Close without completing remaining subtasks** for eligible local activities, including one-off activities.

Closing records **Closed without completing remaining subtasks**. Finished steps stay checked and unfinished steps stay unchecked. Earned points and their history remain; closing awards no additional points and does not create a completion or zero-point settlement. Closed activities and their helper projections stop appearing as active work, and their progress controls are disabled.

For recurring activities, closing advances the existing schedule once. Repeat from completion advances from the household-local close date. Existing successors survive closing, reopening and resetting the old occurrence. Retries cannot create a second successor. If recurrence cannot advance safely, the close is rejected atomically.

**Reopen activity** resumes saved progress. It neither resets children nor changes existing earnings or future occurrences. Newly finished work uses normal earning rules; explicitly unchecking a previously credited step retains the existing frozen-credit reversal/restoration behavior. Reset remains a separate action. If the old deadline has passed, reopening changes this occurrence to Keep overdue; already-created future occurrences retain their own policies.

An authorized household parent or administrator must have the existing whole-scope Skip authority, including visibility and lock authority for affected original work. Child and device completion grants do not grant Close or Reopen. No permissions are automatically granted by this feature.

Coupled Workflow and rotation work, synced/pending-export work, prize deliveries and payment tasks retain their existing lifecycle. They are excluded from this action until their cancellation semantics are defined. Ordinary completion, Skip, expiration and archive remain separate outcomes. A closed activity does not satisfy a Workflow dependency.

The rotation exclusion includes the authoritative next recurrence definition and template assignment cursor, even when this occurrence has a fixed-assignment exception. Existing expired-child Reopen also respects closed structural and helper-source ancestors. Device active lists omit closed source work; direct and historical helper views show the closure without rewriting saved checkbox records.

## API and compatibility

- `POST /api/v1/tasks/{id}/close-incomplete`
- `POST /api/v1/tasks/{id}/reopen-incomplete`

Both accept only `operation_id` and `expected_revision`. Reuse the exact body after an uncertain network outcome; current authority is rechecked and the response contains the current Task projection. An operation ID cannot be reused for a different action or revision. Generic status updates cannot close or reopen a closed activity.

The distinct status is `closed_incomplete`, with `closed_incomplete_at` and an activity-history event. Additive migration10064 expands the status constraint while preserving existing rows, references, indexes, triggers and sequence values, and adds empty closure/receipt metadata. Old categories, assignments, template launch receipts, recurrence definitions and award records are not backfilled or rewritten. Cache91 is retained in this local candidate; a separately authorized release must integrate a fresh cache version.

This is a local implementation/testing candidate. Publication, deployment and actual household changes are outside its authorization.
