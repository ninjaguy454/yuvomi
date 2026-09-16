# Wall and Rewards release follow-up

This bounded follow-up extends the unreleased additive migration 10034. It does not add a second migration or rewrite the validated 3084eaaa commit.

## Recurrence frontier

`task_recurrence_occurrences` keeps stable series, predecessor, generation and scheduled-key provenance independently of the live Task foreign keys. Deleting a Task marks its provenance deleted; it does not split surviving successors into another series. Only the latest surviving materialized generation may advance. A deleted latest occurrence may be regenerated, but an older deleted hole is never filled while a later generation survives. A partial unique index prevents two materialized rows with the same series/key, and immediate transactions serialize deletion and reconciliation.

Archive changes presentation only. Archived occurrences still count in the frontier. If every occurrence is deleted, no surviving Task remains from which to infer its structure/rule; reconciliation creates nothing. Legacy backfill uses predecessor links and frozen completion series, never matching titles. Ambiguous branches or duplicate materialized keys stop migration for review.

Completion remains the ordinary materialization trigger. `reconcileTaskRecurrence` is an explicit mutation entry point for maintenance; GETs do not generate work. Existing calendar-anchored versus completion-relative calculations remain authoritative. A completion that would calculate an already materialized recurrence date fails with an explained conflict and rolls back, rather than silently losing the next occurrence or creating a duplicate.

The narrowly scoped retirement service preserves original Task rows, completion state, dates, ledger, comments, documents and linked history. It archives the occurrence and reliably linked helper trees, records a present-day retirement event, and removes the occurrence from frontier calculations. Retired work cannot be completed/reset/reopened through the operational lifecycle. Retirement is an explicit maintenance action, not the meaning of ordinary Archive.

Award receipts survive physical deletion and also claim a durable series/date/action identity. Copied actions inherit their explicit source lineage, including delegated actions with their own points. Regenerating an already rewarded date does not award again. An explicit corrected retirement can release the old claim only after every original earn is fully offset by canonical adjustments linked to that earn. Receipt retirement is recorded separately; the original earn and receipt are retained. Ordinary retirement alone cannot release points.

## Search

Ordinary Search adds `tasks.archived_at IS NULL` before limiting results. Not Started, In Progress and completed-but-unarchived Tasks retain their existing audience. Archived private and household Tasks are excluded equally. List, Kanban, Dashboard and canonical authorization are unchanged. An explicit Include archived Search control is deferred; adding a new global Search filter is unnecessary for this release.

## Administrator point adjustments

The Points history surface offers Adjust points, with member, signed whole-number amount, required reason and optional Task/Reward/ledger references. A related history row can prefill provenance. Signed entry uses the normal text keyboard, including on Android keyboards that omit minus from numeric layouts.

`POST /rewards/adjustments` appends an `adjust` ledger transaction. `reward_adjustment_requests` atomically stores the actor/request key, immutable request fingerprint, ledger result and optional reference snapshots. Replays return the original result; conflicting payloads fail. Every submission and retry rechecks the actor's current administrator role. Missing keys ask legacy clients to refresh. The compatibility `/bonus` route uses the same durable service while retaining positive-bonus categorization. Balances remain the sum of ledger transactions, including negative adjustments.

Related Task access follows canonical Task authorization. Optional provenance does not grant permission to view private work. The original transaction is never rewritten/deleted to correct a balance. Disabling or deleting a referenced entity does not remove the reference snapshot.

Deleted Task-derived descriptions remain redacted in shared point history. Mixed-case compatibility paths use the same fresh authorization/idempotency boundary. After an uncertain submission result, the form keeps the submitted snapshot and request key; reopening recovers the pending adjustment instead of silently treating edited values as another correction.

## Emoji rendering

The complete bundled 3,944-RGI catalog and localized CLDR search remain unchanged. The picker initially shapes at most 48 visible glyphs, then hydrates 12 per yielding frame. Search/scroll/category changes cancel obsolete batches; variants remain secondary. Pending tiles are not selectable. Retained visible rows stay in place instead of being removed/reinserted on each scroll.

Three fresh-browser samples at 1920×1080 and 4× CPU throttling measured median open 508→343 ms, cold category 340→151 ms, cold new rows 343→66 ms and warm scroll 33→14 ms. Broad `bi` typing improved 369→127 ms; ordinary `movie` search remained about 31–33 ms. These are first-paint observations, not a claim that all visible glyphs finish instantly or that every interaction is under 100 ms.

## Release and repair safeguards

The separately requested Kanban refinement combines Not Started and In Progress into one Active banner, with Completed separate. Card status icons retain the actual status. Moving within Active does not mutate status; reopening Completed work uses the existing In Progress transition, preserving checklist progress. List and Calendar grouping are unchanged.

Validate 10033→10034 and restart/no replay against an isolated encrypted production copy. Retain a fresh encrypted backup, previous image and configuration before production deployment. Restore the pre-deployment backup with the old image for a complete rollback of the new provenance and repaired state.

The authorized Laundry repair is a one-time operation, not a scheduled job. Its preview, exact IDs, preservation assertions, adjustment references and results are retained with the release evidence. Original early-completion earns remain in history and are offset by append-only corrections.

Chromium touch/viewport/CPU emulation does not establish physical Android font or Fully Kiosk behavior. The user will test the Apolosign after deployment; that remains a known acceptance limitation.
