# Relative Activity Template scheduling — 2026-09-18

Local successor to `4b9ea0700934f6c7bbb9a9903e9c8ebc746fa7b2`, on `fix/task-relative-offset-20260918`. The final commit is the commit containing this report; no validated commit was amended, rebased, or rewritten. Publication and deployment are explicitly excluded by the latest delivery instruction. No production Tasks or configuration were changed.

## Final scheduling model

Activity Templates expose **Start time**, **Due** (Same day, 1–7 days later, Custom), and **Due time**. Custom accepts whole calendar days from 0 through 3650. The template stores nullable `due_date_offset_days`, Start Time, and Due Time; it has no absolute Start Date or Due Date columns, controls, catalog fields, or create/edit payloads. Concrete Tasks still store their actual dates and times.

The concrete Start Date comes from manual creation, the recurrence occurrence, or the Workflow caller. Due resolves as Start Date plus the template's calendar-day offset. Selecting a template retains the occurrence Start Date already entered. Subsequent Start Date changes update the derived Due until the user explicitly overrides Due. Blank restores normal New Task defaults. There is no guessed manual occurrence date.

Save as Template copies reusable times and derives the calendar-day span between valid concrete dates. It strips literal dates even from an older template object. Insufficient dates produce a null offset. Template creation immediately refreshes the existing dropdown without replacing the original draft. Existing template-switch warnings and the warning opt-out remain intact.

## Compatibility and recurrence

Existing time-only templates migrate to offset 0. Wholly untimed templates remain null, with no invented times. Opening and saving an unchanged null schedule retains null even though the selector displays Same day. Explicitly choosing a Due interval establishes relative timing.

Concrete Tasks also gain a nullable offset snapshot. **Existing Tasks are not backfilled.** Null retains their existing due-based recurrence. Newly generated relative Tasks save the resolved span, including an allowed concrete Due override. Their next fixed occurrence is anchored to Start Date; the next Due is independently resolved from that Start plus the snapshot. Later template edits cannot move existing occurrences. The existing due-derived occurrence key, recurrence frontier, transaction protections, and duplicate-successor safeguards remain in use.

Authorized edits and expired-Task reopening update an existing relative snapshot when dates change. CalDAV deadline updates do the same for already-relative Tasks; ordinary imported/legacy Tasks remain null. Clearing either concrete date boundary removes relative scheduling for that Task. Restoring dates later does not silently re-enable it; the Task then follows existing legacy recurrence. This explicit-clear behavior is covered by API tests.

Rotation cohorts cannot mix legacy and relative anchors or incompatible relative windows. The guard only constrains the newly introduced relative mode; existing null-snapshot cohorts can retain different Start Date lead-ins.

Repeat from completion still derives the next occurrence date from successful completion. Expiration remains terminal but does not impersonate completion: completion-relative routines pause until authorized reopening and actual completion. Optional flags, fresh occurrence progress, supervision, points, and expiration behavior remain unchanged.

## Acceptance results

| Case | Verified outcome |
| --- | --- |
| Get Ready for the Day | Desktop full-app creation: Eleanor accepted; 2 points; weekday recurrence; offset 0; 07:00–08:00; expire incomplete persisted. |
| Missed Monday morning | Monday expired at its deadline, earned zero, retained partial/optional history; Tuesday materialized fresh with 07:00–08:00, 2 points, and incomplete actions. |
| Successful morning routine | Required completion awarded exactly 2 points once; optional actions did not block; next occurrence retained weekday anchoring and fresh progress. |
| Eleanor's Weekly Homework | Mobile full-app creation: 5 points, Keep overdue, weekly Monday, offset 4; Monday September 21 at 15:30 resolved to Friday September 25 at 07:30. |
| Homework across DST | October 26→30 and November 2→6 retained Monday 15:30 and Friday 07:30 with the correct household UTC offset change. |
| Overnight | Same-day 22:00→06:00 rejected with the Due field focused and a suggestion to choose 1 day later; offset 1 accepted. |
| Spring DST | Calendar-day arithmetic preserved 22:00→next-day 06:00 across the spring transition, correctly spanning seven elapsed hours. Both DST transitions have helper/API coverage. |
| Workflow | Supplied October 5 occurrence Start resolved offset 4 to October 9; preview and creation agree and use the resolved window for eligibility. |
| Template/draft behavior | Create/edit, Save as Template, immediate dropdown refresh, original draft preservation, switching, Blank, custom offset, manual Due override, and validation focus passed. |

Calendar arithmetic operates on date keys, not 24-hour additions to household instants. Existing household timezone/window helpers continue resolving wall-clock restrictions and expiration.

## Preserved checkbox feedback

The card optimistic implementation, shared queue, Task Details implementation, checkbox CSS, and corrected probe are unchanged from `4b9ea070` (source comparison verified). Changes in `public/pages/tasks.js` are confined to the scheduling import/form paths. No completion work was added to the optimistic pre-paint path.

The corrected full application benchmark was rerun with real routing, styles, session/CSRF authentication, server, synthetic SQLite, scheduler and live events. All **21/21** interactions passed: seven paths each in Task Details, expanded List, and Kanban. Paths include first/middle/final required, optional, supervised/helper, delegated/helper, and reopening. Final required completion still produced exactly one reward and successor.

| Middle required step | Previous candidate second frame | Current second frame | Current local HTTP acknowledgement |
| --- | ---: | ---: | ---: |
| Task Details | Fast path retained | 29.7 ms | 98.7 ms |
| Expanded List | 30.3 ms | 30.6 ms | 103.0 ms |
| Kanban | 30.5 ms | 30.3 ms | 113.5 ms |

These frame callbacks are a proxy, not proof of painted pixels. A separate JPEG screencast was inspected frame by frame with an intentional 500 ms transport hold:

| Surface | Last inspected unchecked frame | First inspected checked/progress frame | Held acknowledgement |
| --- | ---: | ---: | ---: |
| Expanded List | 9.23 ms | **26.84 ms** | 608.0 ms |
| Kanban | 23.73 ms | **40.04 ms** | 602.8 ms |

Both captured raster results meet the <50 ms target and precede HTTP acknowledgement. Across the native matrix, expanded List second-frame observations were 29.9–30.9 ms and Kanban 30.3–31.3 ms. These are individual controlled samples, not percentiles or physical-display measurements. Actual household devices, app wrappers, and production HTTPS acknowledgement were not benchmarked in this pass.

The preserved interaction remains local provisional feedback → revision-checked HTTP mutation → canonical reconciliation; initiating clients do not wait for SSE. Final parent completion, points, and recurrence remain authoritative. Browser regressions cover rapid different-child actions, duplicate suppression, stale rejection/rollback, pending state surviving list refresh, retained row/focus/scroll/expansion, optional actions, live permission changes, two independent clients, and native touch scrolling versus deliberate taps.

## Validation and evidence

| Gate | Result | Local evidence |
| --- | --- | --- |
| Template API, pure calendar helpers, encrypted migration | 16/16 pass | `.qa/activity-offset-20260918/backend.log` |
| Relative generation + existing recurrence/workflow/expiration/optional suites | 109/109 pass | `.qa/relative-generation-regressions.log` |
| Final route/cohort/generation/frontier/round-robin gate | 47/47 pass, including 12 relative Task API and 11 generation cases | `.qa/relative-cohort-regressions.log` |
| CalDAV deadline compatibility, expiration consumers, repeated encrypted rehearsal | 13/13 pass | `.qa/activity-offset-20260918/caldav-migration.log` |
| Draft/editor units | 16/16 pass | Tool output: `node --test test/test-task-draft.js test/test-activity-template-editor-fields.js` |
| Mounted editor/browser paths | 22/22 pass, desktop/tablet/mobile | Tool output: `node --test test/test-task-draft-ui.js`; no retained file log |
| Full-app template acceptance | Desktop morning and mobile homework pass; screenshots inspected | `.qa/relative-template-20260918/full-app-results.json` |
| Full-app expanded-card browser tests | 6/6 pass | `.qa/task-relative-offset-20260918/card-browser.log` |
| Task Details browser suites | 29/29 pass | `.qa/relative-template-20260918/detail-browser-regression-verified.log` |
| Queue/controller tests | 33/33 pass | `.qa/relative-template-20260918/queue-controller-regression.log` |
| UI/optional inspection cost/append-only migration checks | 53/53 pass | `.qa/task-relative-offset-20260918/static.log` |
| Shared pure-module boundary/source guard | 3/3 pass | Tool output: `node --test test/test-layer-boundary.js` |
| Backend lifecycle/security/live/recurrence/SW gate | 364 pass; one existing baseline failure out of 365 | `.qa/task-relative-offset-20260918/regression.log` |
| Corrected full-app performance probe | 21 native interactions + 2 held raster captures pass | `.qa/task-relative-offset-20260918/relative-native/` and `relative-visible/` |

Suites overlap; counts above must not be summed as unique tests. An initial Details run used Docker `--network none`, which makes Chromium report offline and prevents mocked EventSource initialization. It produced 22 passes and seven failures. The same unchanged suites passed 29/29 with an internal-only network. That failed infrastructure run is retained separately and is not counted as passing. No browser-launch failure was counted as a pass. The first backend run also found a stale case-sensitive assertion expecting the old `Due Time` wording; it was updated to require the new error and explicit `Set Due to 1 day later` guidance, then the full focused gate was rerun.

## Migration and production boundary

Reworked undeployed **10037** adds only:

1. Nullable integer `activity_templates.due_date_offset_days`, with a nonnegative integer check; timed existing templates receive 0.
2. Nullable integer `tasks.due_date_offset_days`, with the same check; all preexisting Tasks remain null.

It adds no absolute Activity Template date columns. Source preceding migration 10037 is identical to the base commit, including deployed migrations 10035 and 10036.

The rehearsal created an encrypted, production-shaped schema 10036 using the real migration chain and representative timed, due-only, start-only and untimed templates, optional checklist state, and an existing concrete Task. Unkeyed opening failed, proving encryption was active. First startup applied **only 10037**. Existing template values and Task values were preserved, only expected offsets were added, previous migration history was identical, integrity was `ok`, foreign-key violations were zero, and a fresh process restart applied no migration and retained identical history. The rehearsal was repeated after the final backend changes.

Read-only production inspection confirmed image `yuvomi:release-4f93b3caefe12f88a648591b59e3c49d46bebaf0`, revision `4f93b3caefe12f88a648591b59e3c49d46bebaf0`, schema 10036, 206 migrations, encrypted storage, integrity `ok`, zero foreign-key violations, and healthy container status. Aggregate template compatibility inspection found three templates, all untimed, and zero invalid same-day windows. They retain null offsets on migration. No production migration, restart, backup operation, image build, push, or deployment was performed.

## Known limits

Physical-device timing and production HTTPS acknowledgement remain unmeasured. The local browser evidence proves controlled Chromium raster feedback and functional touch behavior, not display latency on the household hardware. The broad regression gate finished with 364 passes and the one previously documented reward-ledger expectation failure at `test/test-task-subtask-latency-integrity.js:164`: reopening is expected by that old assertion to erase an earn, but the existing durable ledger retains it. Its identical failure on unchanged deployed source is retained in `.qa/task-feedback-followup-20260917/baseline-known-failure.log`. No unrelated reward behavior was changed. No candidate regression remains in the focused checks.
