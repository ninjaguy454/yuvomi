# Task expiration and recurrence

`Keep overdue` retains the existing behavior. `Expire incomplete` closes an
unfinished occurrence at its household-local due deadline. Expiration is
historical evidence of a missed opportunity, not successful completion.

## Setting and deadline

Task and Activity Template editors expose **When incomplete at deadline** with
`Keep overdue` (the migration/default value) and `Expire incomplete`. Template
policy is copied when an Activity creates a Task; later template changes do not
rewrite existing occurrences. Tasks require a Due Date to enable expiration.
Due Time is the boundary; without a Due Time, the entire due day remains useful
and expiration occurs at the next household-local midnight. No separate
expiration deadline is introduced. `expired_at` records the transition boundary.

Optional Start Time extends the existing Start Date so a recurring 7:00–8:00
routine cannot be completed before 7:00. Both boundaries use the household
timezone and existing Availability DST policy: nonexistent local times move
forward through the gap, and repeated local times use their first instant.

The startup worker and five-second background sweep perform expiration.
Completion and progress mutations enforce the deadline under the writer lock,
even before the next sweep. Reads do not change Task state.

Expired Tasks keep their configured point value for recurrence and authorized
reactivation, but show zero available completion points and create no completion
earn or receipt. Existing rewards for independently point-bearing subtasks
completed before the deadline remain historical rewards; expiration adds none.

Only existing Task definition/date editors can change this policy or explicitly
reopen an expired Task; Activity Template settings use their existing edit
permissions. Reopening preserves completed subtasks and requires a new future
deadline or an explicit switch to Keep overdue. The UI confirmation uses Keep
overdue and explains that an already-created successor is unchanged, while a
paused completion-relative routine will inherit that choice when it resumes.

Expired and Archived are independent. Restore an archived occurrence before
reopening it. Pending helper obligations stop, historical supervision mappings
remain, and queued overdue reminders are suppressed. No extra expiration
notification is emitted.

## Calendar recurrence

An expired occurrence is terminal for recurrence progression. Its successor
uses the next date in the existing recurrence rule, anchored to the expired
occurrence's due date. Due time and the configured point value carry forward;
the successor starts with fresh incomplete subtasks. Completed subtask history
stays on the expired occurrence.

For a daily 7:00–8:00 morning routine worth 2 points, missing Monday closes
Monday with no parent completion award. Tuesday remains Tuesday with its own
fresh work and 2-point value. Expiration does not move the calendar anchor to
the time when reconciliation runs.

After downtime, missed dates advance in sequence. Each materialized missed
occurrence can expire before the next one is generated. Date-only recurrence
arithmetic and household-local deadline evaluation preserve wall-clock times
across daylight saving changes.

## Repeat from completion

An explicitly completion-relative interval starts only after successful
completion. Expiration supplies no completion anchor, so automatic progression
waits. An authorized editor can reopen the expired occurrence, update its
deadline when necessary, and complete it; the next interval then starts from
that actual completion date. The configured recurrence mode is never silently
changed to calendar recurrence or recurrence from expiration.

For rotation cohorts, every member must be terminal before the cohort can
advance. A completion-relative expired member has no next anchor and prevents
a partial cohort advance until resolved. Calendar cohorts containing both
completed and expired members use the same next scheduled date for every
member, including when reconciliation resumes after several missed days.

## Occurrence identity

Expired history retains its durable materialized occurrence identity, including
when archived. Expiration must not retire or delete recurrence provenance.
Reopening a historical expired occurrence does not move the series frontier
backward or delete a successor. Its later completion can only generate a
successor if it is still the latest frontier.

Completion, expiration, and explicit recurrence reconciliation serialize their
database mutations. Existing predecessor checks and the unique materialized
series/date key prevent duplicate successors. Reads do not advance recurrence.

## Recovery and history

Expiration commits even when creating the next occurrence temporarily fails,
for example because assignment eligibility cannot currently be resolved. The
missed occurrence remains expired and cannot earn completion points. The
background reconciler retries the latest expired calendar frontier on startup
and subsequent sweeps; a retry does not create a second expiration event or a
duplicate successor. Each sweep handles a bounded number of missed dates and
continues on subsequent sweeps. An archived expired frontier remains eligible
for this recurrence recovery because archiving history does not disable its
recurrence.

The existing household and series history endpoints include both `completed`
and `expired` occurrence events. `occurred_at` orders the combined history;
expiration carries `expired_at`, `completed_at: null`, no completing user, and
zero points. The archive flag stays independent from the lifecycle status.
The Task activity stream preserves prior completed subtasks and the expiration
event. Global search retains unarchived expired history alongside completed
history; operational dashboards and Active Tasks omit expired work.
