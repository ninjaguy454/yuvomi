# Skip this occurrence design

Status: Approved by Duane on October 10, 2026 for implementation and testing of the first calendar-only version, without Undo. Skipping applies to the whole materialized occurrence. Live Task changes, live permission grants, publication, and deployment remain unauthorized.

## Intent and confirmed behavior

A parent or another explicitly authorized manager can excuse one recurring Activity occurrence without completing it, awarding new points, leaving overdue work, or changing the series definition. The occurrence remains visible as **Skipped** in history, and the next calendar occurrence continues on its normal schedule with fresh work and its configured points.

The action is named **Skip this occurrence**. It applies to every assignee and the occurrence's unfinished work. There is no separate Skip everyone action, person selector, or per-person excusal record. Individual exceptions use the existing assignee-removal flow, under its existing permissions and occurrence-versus-series editing rules. Skipping itself does not change assignments.

Do not request or store a reason, health information, or another personal explanation. Do not introduce a Task type, a parallel Activity model, or alternative points. Keep the pending Task card, color, and theme design work outside this change.

## Existing foundation and scope classification

The inspected baseline is commit `62329fa9d40819a80fab65ec1fe5087179e209be`, tree `bbce4b84558b8e90a47b1300d99c9f878e3d936f`, matching the cache-71 deployment handoff.

The existing lifecycle already distinguishes completion from expiration. `expireTask` closes unfinished work and obligations without completion rewards, and calendar recurrence advances from nominal dates. Durable occurrence provenance keeps series identity, generation, planned dates, and a unique materialized series/date key. The latest surviving frontier and predecessor checks prevent duplicate generation. Versioned definitions isolate a series from its originating Activity Template.

This is an architectural extension of an existing lifecycle, rather than a new recurrence engine. A real terminal **Skipped** state changes the shared Task contract used by the database, scheduler, progress writers, helper projections, rewards, history, API, and clients. A menu-only change or use of deletion would leave those contracts inconsistent.

The recommended first release supports materialized, top-level, local calendar-recurring Tasks, including Activity Template-backed routines and shared assignments. Materialized future occurrences may be excused before they start when the confirmation names their exact date. Skipping does not require the work's completion window to have begun.

The first-release server rejects completion-relative series, round-robin or rotation-bound/cohort work, Workflow containers or linked dependencies, and CalDAV-linked or pending-export work. Check the entire affected closure, including linked helper rows, for unsupported ownership or integration. These cases need additional scheduling, dependency, or provider rules; the UI does not present another set of skip choices. A source with `external_source='local'` but a CalDAV export target is still integrated work.

Arbitrary dates without a materialized Task are outside this release. Supporting them would require a durable series/date exception consumed atomically by generation. Do not manufacture an occurrence by guessing from its title, deleting a predecessor, or temporarily completing it.

## Outcome and retained records

Add `skipped` to the Task status contract and persist a server timestamp such as `skipped_at`. Record the human actor, prior root status, immutable series/date identity, affected scope, and operation identity in the existing Activity audit and a durable idempotency receipt. An append-only migration must preserve existing rows, indexes, triggers, references, and the Task ID high-water mark. Update the schema mirror and client/API status definitions together.

Keep recurrence provenance in `state='materialized'`. Do not retire it, release an award claim, or change its occurrence key. Keep assignments, definition IDs, planned dates, concrete dates, configured points, reusable series configuration, and the source template unchanged. Existing legacy definition/provenance initialization may run through the established proven-frontier helpers inside the mutation transaction; it must not author a new reusable policy.

Only unfinished rows in the occurrence's structural and linked helper closure become skipped. Completed steps, their receipts, comments, documents, supervision evidence, and earned ledger entries remain intact. Independently archived historical rows are preserved rather than revived. No unfinished row becomes `done`, no completion receipt is inserted, and no earn, reversal, or adjustment is booked. The skipped occurrence exposes zero available completion points; its configured value remains available to future occurrences.

Cancel active responsibilities, pending or accepted obligations, and unfinished assignment contexts for skipped work, while retaining historical rows. Reconcile pending supervision to `not_required` with a generic explanation that the occurrence was skipped. The helper refresher and read projections must recognize a skipped source or ancestor so that they cannot recreate obligations, restore actionability, or mark an empty helper scope successfully completed.

Treat skipping independently from archiving. A skipped Task may later be archived or restored without losing its outcome or reopening its completion window. Restoring an independently archived child under a skipped ancestor must not make it actionable or eligible for deadline expiration; source/ancestor closure guards also apply to deadline sweeps.

## Allowed transitions

| Saved root state | Result of Skip this occurrence |
| --- | --- |
| Open or In Progress | Skip the occurrence and its unfinished scoped work, preserving partial progress. |
| Expired | An authorized manager may correct the current outcome to Skipped. Preserve the original expiration event and deadline evidence in Activity. Clear the current expiration marker as part of the transition; keep any existing successor unchanged. |
| Done | Reject. Do not relabel completed work or erase awards. |
| Skipped | A matching operation replay returns the current authorized state without another event, award, or successor. A separate request reports that the occurrence is already skipped without writing. |
| Archived | Require the existing restore action before a new skip transition. Restore does not itself excuse or reopen work. |
| Deleted, retired, or unproven occurrence | Reject; never reconstruct it through this action. |

Skipping after the original deadline is an authorized excusal, so it is not subject to the completion deadline gate. If a background expiration commits first, the old revision fails and the user must reload before deliberately correcting Expired to Skipped. Existing historical earnings are never made unearned, including where a previously completed root was explicitly reopened.

## Authority

Use a distinct human capability, `tasks.skip_occurrence`, with default access `none`. Administrators receive the existing administrator capability resolution. Non-admin parents or supervisors require explicitly configured authority; do not infer it from family-role labels, assignment, `complete_own`, generic editing, or current helper status. Add no default role/member/device grants and change no live permission records.

The capability remains subject to current Task visibility, the existing source/lock boundary, and authority over the entire affected occurrence closure. Reject the operation if an independently protected action would be affected without authority. A supervisor's permission to finish one transferred step does not authorize excusing the whole occurrence. Generated helper projections and subtasks are not direct skip targets.

Paired devices do not gain excusal authority in this release. A supported real human authorization flow may supply its human principal and normal display-origin audit evidence; choosing a device recipient never establishes that authority.

Recheck current authorization on every mutation and replay before returning receipt-derived information. Permission revocation must not be bypassed by a previously successful operation ID.

## Atomic operation and recurrence continuation

Expose a dedicated endpoint such as `POST /tasks/:id/skip`, accepting the existing expected Task revision and an opaque operation ID. It does not accept an assignee selection, reason, alternate points, dates, or series edits. Ordinary status PATCH, definition PUT, compatibility writers, and provider imports must not acquire a way to complete or reopen skipped work.

Under one immediate writer transaction:

1. Validate the request shape, target existence, and current human authority, then look up a principal-scoped idempotency receipt. Reject reuse of an operation ID with different input; an exact replay performs no mutation and returns the current authorized state. Check mutation-only state/mode preconditions after receipt resolution, so a later archive or series edit does not reapply or obscure a confirmed operation.
2. Check the root revision, complete authorized closure, and supported recurrence mode/integrations. Derive all affected rows from authoritative structure and projection links. Child revisions already propagate to ancestors; do not use a browser's saved row count as the scope.
3. Preserve existing completed evidence; transition unfinished scoped rows, cancel their obligations, and record exactly one root skip audit event and action receipt.
4. Attempt the next calendar occurrence using the existing authoritative definition and nominal recurrence planner. Use the no-completion calendar anchor path, not the skip timestamp or today's browser date. Do not fabricate completion or expiration evidence to obtain an anchor.

If successor materialization fails temporarily, its savepoint rolls back while the excusal and receipt remain durable. Extend the existing startup/timer recovery scan to retry latest skipped calendar frontiers. The normal unique series/date key, predecessor and frontier checks still apply. A request must distinguish durable excusal from pending next-occurrence generation; it must not claim that the next occurrence exists when generation failed.

An already-materialized successor stays intact. Skipping an older occurrence cannot move the frontier backward, regenerate its date, delete future work, or rewrite future assignments/progress. Later series edits must preserve skipped history as historical work.

After downtime, advance scheduled dates in their normal order. Only the selected occurrence is excused; skipping it does not excuse later missed dates. Those later occurrences retain their ordinary expiration policy. When the recurrence rule has ended, a skipped final occurrence is a valid terminal result with no successor.

All dates and deadlines use the household timezone and existing gap/fold policy. Keep nominal date arithmetic separate from timestamps. Target the saved occurrence ID/key; do not resolve "today" from the client timezone or add a fixed 24-hour timestamp interval.

## Races and other writers

Completion, expiration, skip, assignment edits, and series edits serialize their database mutations. If completion wins, Skip rejects the stale/current completed state and its valid award remains. If Skip wins, stale child or parent completion and reward calls cannot pass a skipped ancestor; the expiration sweep rereads state and does nothing. If expiration wins, a fresh authorized correction may excuse it while preserving its audit and successor.

Unknown network outcomes reuse the same operation ID and exact request. A durable receipt resolves retries without a second event or successor. Validation, authority, or stale-revision failures leave no partial skip, obligation change, or receipt. Concurrent assignment removal either commits before Skip and is reflected in its confirmed scope, or causes a stale revision; Skip never removes another person as a side effect.

Update shared mutation guards, direct award guards, parent progress derivation, helper reconciliation, and normal client controls to respect skipped ancestry. Preserve the difference between terminal-for-recurrence and successful completion. Workflow dependency and rotation settlement rules remain unchanged while those targets are excluded.

## Presentation and projections

Place **Skip this occurrence** with existing Task Details actions. A single confirmation states the occurrence date and that its unfinished work is excused for all current assignees, no new points are awarded, and future occurrences retain their schedule. There is no audience selector. Show the current participant strip rather than inventing a separate per-person flow. Cancel writes nothing. Do not optimistically represent success until the server confirms durable excusal.

Use the visible outcome **Skipped** and explanatory text such as **No new completion points awarded**. Retained earned subtask points remain visible where history already shows them. Disable progress, claim/accept, drag-to-complete, and active countdown controls for skipped work; the current history/details remain readable under existing visibility rules.

Extend the existing occurrence feed and Task Details/History presentation with skipped events. Show the date of the saved occurrence and the skip timestamp separately where needed. An expired occurrence later excused has one governing Skipped outcome in occurrence history and current counts; its earlier expiration remains in Activity, not a second current missed outcome. Scope history before pagination and preserve existing completion IDs/cursors.

Exclude skipped work and children of skipped occurrences from active/overdue counts, offers, dashboards, reader/wall views, countdowns, and actionable notifications. Suppress both unsent reminders and queued delivery retries using source/ancestor state; retain historical delivery evidence. Explicit history/search views may show Skipped. Existing Task completion statistics must not count it as completion. No Task streak feature or health-record write is added.

## Undo recommendation

Do not include Undo in the first release. Existing deletion Undo delays the DELETE; it cannot safely delay excusal across an expiration boundary. Existing expired reopening switches to Keep overdue, so reusing it would change the selected policy and potentially future completion-relative behavior.

A later dedicated Unskip may be designed for local nonrotating occurrences before their original deadline. It must have the same authority and fresh revision checks, identify exactly which rows the skip operation closed, preserve completed progress and existing successors, and reconcile current helper eligibility instead of restoring stale supervisors or replaying cancelled obligations blindly. After the original deadline it would require an explicit deadline/policy decision. It must not clone the Task, erase the skip audit, or delete its successor.

## Validation and evidence

Use synthetic data only. Required acceptance cases are:

- Whole-occurrence skipping for a single assignee and several assignees; no person selector or per-person records. Exercise existing assignee removal separately, including a concurrent removal versus Skip and an occurrence-only removal that leaves future recurrence definitions intact.
- Open, partially complete, expired, completed, skipped, archived, deleted, and retired roots; retained comments/documents/supervision evidence and all historical earn/award rows; zero new rewards or completion receipts from Skip.
- Stable series/date identity, unchanged reusable configuration and configured points, fresh successor checklist, existing successor preservation, ended rules, stale series edits, and skipped-history protection from future reconciliation.
- Completion/expiration/skip and child-progress races through separate connections/processes; exact retry, lost-response replay, mismatched operation IDs, permission revocation, validation failure and rollback. All test workers must use the same intentional clock.
- Temporary generation/eligibility failure followed by startup and sweep recovery; bounded catch-up across missed days; no duplicate occurrence keys and no broad excusal of later dates.
- Parent/admin/scoped supervisor authority, ordinary child and device denials, locked/private actions, and unsupported completion-relative/rotation/workflow/CalDAV targets, including pending export links in the closure.
- Helper refresh, obligation inbox, direct reward calls, stale client/provider writers, default and explicit Task views, dashboards, wall/reader/countdowns, search/history pagination, unsent reminders and queued notification deliveries, and two-client live invalidation.
- Household midnight, date-only due days, before-start excusal, exact deadline boundaries, DST gaps/folds, and a client in another timezone. No changes to future nominal dates or timezone policy.
- Append-only encrypted migration rehearsal, schema mirror, foreign keys, indexes/triggers, ID sequence, existing records and a second startup without migration replay. Browser confirmation, Cancel, keyboard/mobile interaction, and retained Details/history should use existing layouts and tokens.

The read-only baseline lifecycle run passed 46 of 47 checks across expiration, recurrence, consumers, frontier and race suites. The existing frontier worker fixture is order-dependent because the parent freezes September 15 while workers use real time. A controlled deletion-then-worker probe generated October 9; aligning its clock generated the expected October 2 and passed. These diagnostic copies did not change product or tracked test source. They do not verify the proposed feature.

Key source evidence: `server/services/task-lifecycle.js` (`expireTask`, revision and window guards), `task-recurrence-frontier.js` (identity/frontier/award provenance), `task-series.js` (authoritative definitions and nominal planner), `task-expiration.js` (durable recovery), `task-supervision.js` and `task-supervision-refresh.js` (helper closure), `rewards.js` and `task-completions.js` (awards/history), `server/permissions.js` and `server/task-capabilities.js` (default authority), `server/routes/tasks.js` (canonical writers/deletion/generation), and `public/components/task-detail.js` (actions and History).

## Settled first-release decisions

1. **Initial supported scope.** Approved October 10: materialized, top-level local calendar routines, with the listed integration guards. Repeat from completion, rotation, Workflow and provider-linked support remain excluded until their continuation/dependency rules are designed.
2. **Undo.** Approved October 10: omit it from this release. A later addition requires a dedicated reopening policy and deadline restrictions.

Whole-occurrence scope is settled. Individual exceptions remain in existing assignment editing. No further design approval is pending for this implementation. Deployment remains outside the authorization.
