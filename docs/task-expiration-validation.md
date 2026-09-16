# Task expiration validation

Validated locally on 2026-09-16 with Node 24.19.0, from base commit
`546cded635c5df64dc992886a146fe486a96ea03`, on branch
`feature/task-expiration-20260916`. Tests use isolated databases and synthetic
household data. Production was not changed; nothing was pushed or deployed.

Behavior and recurrence decisions are documented in
[Task expiration and recurrence](task-expiration-recurrence.md). Existing Tasks
and Activity Templates default to Keep overdue. Migration 10035 adds the
Expired lifecycle status, policy, transition timestamp, and optional Start Time.

## Acceptance evidence

| Case | Result and evidence |
| --- | --- |
| Monday morning routine | Verified: daily Get Ready for the Day, 07:00 start, 08:00 due, 2 points. Monday expires, retains a completed child and activity history, has no completion or earn, and leaves Active. Tuesday has the original wall-clock window, fresh incomplete children, and 2 points. `test-task-expiration.js`. |
| Completion at 07:59:59 | Verified: successful completion earns exactly once; later expiration does nothing and does not duplicate Tuesday. API/service and separate-process tests. |
| Completion/expiration and recurrence races | Verified: separate processes sharing a WAL database produce one terminal transition and one successor. Duplicate expiration/materialization and stale PUT/check mutations cannot revive or duplicate work. `test-task-expiration-races.js`, `test-task-expiration-write-races.js`. |
| Restart around the deadline | Verified: a fresh worker process reopens the database after the missed deadline, preserves partial history, and materializes Tuesday; another restart is idempotent. Multiple missed dates and mixed completed/expired rotation cohorts stay anchored. |
| Successor temporarily fails | Verified: expiration remains durable with one history event. A later sweep retries successfully; exhausted earlier recurrence frontiers do not starve retries. `test-task-expiration-reopen-security.js`. |
| DST and household timezone | Verified: America/New_York deadlines across spring/fall offsets, nonexistent and repeated local times, date-only end-of-day deadlines, and consecutive recurrence dates. `test-task-expiration.js`, `test-task-expiration-recurrence.js`. |
| Repeat from completion | Verified: expiration pauses this mode without a fabricated completion anchor. Authorized reopening followed by successful completion supplies the next interval's actual anchor. |
| Supervised expiration | Verified: unfinished helper work expires, obligations/responsibilities stop being actionable, mappings remain, and neither learner nor helper receives a new completion award. Completed independent subtask history remains. Activity/supervision suites and expiration security tests. |
| Reopening | Verified: explicit authorized reactivation preserves partial progress and existing successors, rejects unauthorized/private-descendant changes and invalid deadlines, restores assignment context, and updates inherited child/helper windows. |
| Archived expired occurrence | Verified: archive remains independent; historical expiration survives. Restore is required before reopening. |
| Open clients | Verified: two already-open authenticated SSE streams receive expiration invalidation; canonical reads show the expired occurrence and fresh successor. Browser fixture also verifies open detail/Active/history repaint and reactivation controls. |
| Defaults, settings, and permissions | Verified: Keep overdue preserves old behavior, template policy inheritance, due-date validation, Start Time controls, and child/member restrictions. |
| History, search, notifications, integrations | Verified: mixed occurrence history distinguishes completion from expiration; operational consumers omit expired Tasks; search follows its archive filter; queued reminders are suppressed; CalDAV cannot complete or move an expired deadline. |
| Populated migration | Verified: existing rows, references, assignments, history, indexes, triggers, foreign-key integrity, and deleted-ID autoincrement high-water mark survive the schema rebuild. |

## Test runs

- **51/51 expiration-specific tests passed** in the final run, including the
  real SSE test. Reproduce with `npm run test:task-expiration` on a supported
  Node runtime. Local log: `expiration-feature-validation.log`.
- **647/655 checks passed** in the broader combined regression run. The other
  eight are existing `test-task-optimistic-browser.js` checks: Edge exited at
  browser launch, before their assertions ran. This run preceded addition of
  the final SSE-only test; product code was unchanged afterward. Local log:
  `expiration-final-validation.log`.
- Separate focused runs passed **88/88 frontend checks**, **120/120 Activity
  and supervision checks**, and **198/198 recurrence/consumer checks**. These
  runs overlap the combined run and are not additive totals.
- Chrome interaction checks passed against the reusable synthetic API fixture
  in `test/fixtures/task-expiration-ui.mjs`: editor policy inheritance and
  validation, expired detail and zero points, preserved partial progress,
  Active/Tuesday rendering, Activity/Occurrence history, reopen controls,
  archive restrictions, and live repaint. This verifies frontend behavior
  against fixture responses, not a full browser-to-production integration.

## Existing failures and remaining limits

The following ten failed assertions were reproduced unchanged on the base
commit, separately from the eight browser-launch failures:

| Existing suite | Failed assertions | Finding |
| --- | ---: | --- |
| `test-rewards.js` | 5 | Legacy requests omit current reward idempotency/adjustment fields; downstream redemption expectations then fail. |
| `test-openapi-coverage.js` | 2 | Existing undocumented Wall routes and stale reward endpoint specifications. |
| `test-suite-chain.js` | 2 | Existing orphaned scripts and unregistered test files. The new expiration suite is registered in suite 3. |
| `test-task-subtask-latency-integrity.js` | 1 | Existing assertion expects rewards erased on reopening, while the current durable-award model retains the earn. |

Baseline evidence is in local ignored logs `baseline-rewards-tests.log`,
`baseline-openapi-validation.log`, and `baseline-chain-latency-validation.log`.
The security/performance run passed 70/73, with its three failures accounted
for by the last two rows above (`expiration-security-performance-validation.log`).

The whole repository suite is therefore **not reported as green**. The eight
Puppeteer checks still need a working browser launcher. Production upgrade,
deployment, and production smoke tests remain unperformed.
