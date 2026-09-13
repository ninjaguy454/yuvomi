# Tasks refinement contract

This work starts from production revision ac4e4a26. Production inspection is read-only.

## Existing behavior confirmed

The live Eleanor Laundry occurrence has eight open children and a resolved parent assignee. Five children explicitly require skills. Those child requirements are stored correctly but are not evaluated against the inherited performer. Activity supervision currently checks parent Activity requirements; existing support Tasks have independent completion state. There is no separate approval/finalization state to preserve.

## Operational state

An actionable child is an ordinary, nonarchived child, excluding generated supervision containers and projections. Progress is derived from these children. The first completed child starts an open parent; all actionable children complete the parent, subject to Workflow dependencies and any explicit parent supervision requirement. A reopened child reopens a completed parent to In Progress. Resetting the parent resets its actionable children atomically.

Manual completion with incomplete children requires explicit confirmation. Reset to Not Started requires confirmation when completed child progress or parent completion exists. Cancel writes nothing. Reopening to In Progress retains child progress. Existing completion ledger, rewards and recurrence net-state semantics remain compatible; append-only Task Activity preserves the occurrence's actual completion/reopen/reset history independently of that net-state ledger.

## Supervision

Resolve the actual performer first. A child's own assignee takes precedence over the parent performer. Evaluate only explicit requirements on that action: parent requirements never become implicit child requirements. Existing proficiency rules determine independent, supervised, or excluded performance.

Reuse the existing supervisor support Task container with linked action projections. The source action status is authoritative. The assigned, currently qualified supervisor completes a supervised action from either projection; the learner may complete independent actions. There is no additional pending-approval queue. Both projections update in one transaction. Parent bulk completion cannot bypass a supervised action.

An absent, excluded or unavailable supervisor leaves the learner's Task intact with affected actions and a human-readable explanation. Qualification and the same explained Availability/Presence resolver are rechecked at action time. Fresh occurrences resolve supervision anew. Explicit structural, date, assignment and supervisor mutations reconcile it; profile changes are exposed by read-time validation without silently replacing people. Existing Tasks are not rewritten on reads.

## Permissions

Extend existing role-profile and member-override resolution with capabilities, capped by module access. Preserve current member defaults; administrators can apply a restrictive profile or individual overrides. Private Task visibility remains an additional constraint even for administrators. Server checks cover Task REST and compatibility writers and aggregate reads. Appearance and harmless personal settings remain accessible by default.

The optional Task participant preset grants own-Task viewing, completion/reopening, claiming and comments, plus personal settings. It does not depend on a member's age or family role. A member override can explicitly allow an action denied by their role profile. Omitting `capabilities` from an older permission API update preserves previously configured capability restrictions.

Own responsibility means assigned or created; an unassigned subtask inherits its parent's responsibility. A subtask explicitly assigned to another person does not inherit that operational permission. Current assigned supervisors can view the source container and operate their mapped supervised action, without gaining authority over independent learner steps. Joining or leaving only one's own assignment through the legacy Task update API is a claim/release action; changing someone else's assignment needs assignment/reassignment rights and respects definition locks.

Task visibility also applies to Reader, MCP, Dashboard, Search, countdowns, notifications and reminders, Trips, Meal execution projections, and Task title snapshots in Rewards. Rewards amounts and ledger history are retained when an inaccessible Task's title/link is omitted. Shared Wall projections preserve their existing public-visibility boundary.

Explicit Meal execution Task creation requires `tasks.create`. Administrator-configured Meal automation triggered by participation or plan materialization remains a system workflow; a member's response does not acquire general Task creation/editing rights. Its returned Task projections still enforce the viewer's permissions. Skills, Places and Availability management can be delegated through the same capability system; member administration, household settings, integrations and permission administration remain admin-only.

## Concurrency and synchronization

Add monotonic Task revisions, including changes to child structure/progress and assignment/skill relations. The first-party client submits the expected Task revision and child parent revision. Stale mutations return 409 and never retry automatically. Older compatibility clients without revisions remain supported; their blind writes cannot offer the same optimistic-concurrency guarantee.

Persist a small Task change clock using database triggers so all existing writers invalidate the shared stream. An authenticated SSE stream sends invalidation versions only. Clients fetch authorized canonical data, sequence reloads, refresh on reconnect/focus, and preserve active edit/comment drafts. No Task content or identity is broadcast in the stream.

## Recurrence

Each occurrence retains definitions and explicit skill requirements, starts open with incomplete children and no comments, and reevaluates assignment/supervision. Keep the existing calendar-anchored versus completion-relative choice. Completion and successor generation are one transaction; repeated completion cannot generate duplicate successors.

## Validation

Production inspection used the existing encrypted database in read-only mode. Implementation and browser work used an isolated synthetic household and an in-memory database. No production Task, permission, Schedule or Availability data was changed. Migration 10032 is additive; previous migrations remain intact.

Full-app Chrome checks verified a restricted learner's own Task list, hidden administrative Task controls, disabled supervised completion, automatic first-step progression, linked supervisor completion, live assignment without a page reload, and preservation of an unsent comment through another actor's update. Reset Cancel retained progress and draft; confirmed reset cleared source and supervisor progress and retained Activity history. Calendar opened the same permission-aware detail. Keyboard status changes worked. Desktop, mobile and tablet detail layouts were inspected, including Warm Light and Cool Dark with Serif and Neutral Dark.

Manual parent completion required confirmation, completed all four source actions and generated the next calendar-anchored occurrence with fresh learner and supervisor progress. Reopening retained completion/reopen Activity and showed the historical completion timestamp and actor. An unresolved skill remained visibly blocked with the affected action and an explanation. A linked supervisor remained assigned across household evening/UTC midnight and after the ordinary Task due time.

The rendered subtask editor regression covers Neutral/Warm/Cool × Light/Dark × 1366/768/390 widths with Serif. It checks overflow and touch targets. Shared control browser tests cover all six palettes, text/focus contrast, selected, disabled and hover states. Existing dirty-modal scrolling/selection and draft regressions remain part of validation. The full Task-detail theme coverage is a combination of those rendered component checks and the full-app samples above, not a claim that every possible viewport/theme combination was manually exercised.

The full-app live test exposed an actual service-worker defect: offline Task caching waited for the endless SSE response body. Event streams now bypass that path, with an additional response-type guard. The cache generation advances so existing installed clients receive the corrected module graph. A stream that never closes is covered by regression tests.

Additional correctness fixes found during implementation and adversarial QA:

- Child requirements were not resolved against the actual inherited learner, and helper completion could drift from the source action. Linked source-authoritative transitions now cover completion, reopening and reset.
- Workflow group status could bypass completion/reward/history processing. Nested completion/reset and ancestor revisions now use the canonical lifecycle, including stale root edits after a grandchild changes.
- Reopening an older occurrence could discard a later occurrence containing edits or discussion. New occurrences record a generation revision baseline; changed occurrences and legacy occurrences without a trustworthy baseline are preserved.
- Successful child responses and blocked-operation explanations could expose separately private parent, sibling or dependency details. Canonical visibility now covers those responses, projections and aggregate consumers.
- Unassigned generated helper work could inherit the learner's ownership. It now remains distinct from the learner's source Task, and its definitions cannot be independently edited, reassigned, archived or deleted.
- Archived or deleted source actions could leave executable/orphaned helper projections. Archive/restore preserves links and history; explicit source deletion cleans its mapped generated work.
- A helper performing a point-bearing inherited action could receive the learner's points. The learner remains the reward recipient; the helper remains the recorded actor.
- Remote CalDAV completion could bypass local recurrence or explicit-skill supervision. Those Tasks now enter the canonical lifecycle, with transaction rollback for rejected confirmations or eligibility.
- A household evening could cross UTC midnight and prematurely time out supervision. Linked supervision due dates use household time converted to UTC; ordinary Task lateness is not itself a supervisor-response expiry.

The final combined regression run passed 2,137 tests across 116 test files and 25 suites, with zero failures, cancellations or skips, in 127.4 seconds on Windows with Node 24. The seven new regression files are registered in `npm test` through `test:tasks-refinement`; that focused script also passed all 144 tests independently. Counts overlap and are not additive. Browser regression coverage is included in the combined run. Linux CI, physical iOS devices and a live remote CalDAV provider were not exercised. No push or deployment is part of this refinement.

## Boundaries and operational limitations

- Existing members keep compatible defaults. An administrator must select the Task participant preset or configure capabilities to restrict a particular member; family role or age alone does not apply restrictions. Module visibility remains separately configurable in the same permission system.
- Task duration is still unknown. Shared Availability checks establish an eligible overlap, including a common learner/supervisor interval; they do not prove that a Task fits within that interval. Existing unknown-availability and Presence policy semantics remain in force.
- Existing Tasks revalidate proficiency, membership and Availability on reads and operational actions. A profile change does not silently pick a different supervisor. The unresolved explanation persists until a valid assignment is made.
- Legacy clients may omit expected revisions for compatibility. Their blind writes cannot provide the same stale-write protection as the first-party client. Integration-authored unstructured CalDAV completion retains its existing provider semantics; structured completion cannot bypass confirmation or supervision.
- Task Activity is append-only from this migration onward. Historical records are retained; no events are invented for old actions. The existing completion ledger continues to represent net completion, while Activity records completion, reset and reopening separately.
- Task assignment/reassignment notifications and existing due reminders remain in their established categories/preferences. Supervision requests and unresolved work reuse the existing automation notification infrastructure and deduplication. No second due-soon scheduler is introduced.
- The Task stream publishes only a version and uses authorized reads for content. Visible SPA tabs subscribe and refresh on reconnect/focus; Reader retains its server-rendered interaction model. This pass does not introduce a cross-server event broker.
- List hydration remains query-heavy. Request-local reuse reduced a synthetic 25-parent × 8-subtask request from 9,040 to 7,415 prepared queries and roughly 455 ms to 290–329 ms in local samples. Those timings are directional, not a production performance guarantee. Broader query batching remains future work.
