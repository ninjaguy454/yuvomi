# Task board start-window visibility — 2026-09-21

## Scope and verified baseline

Base: `555a07e4f9725626f7a025ffe36cfb496ca87347`, branch `feature/rotation-groups-20260919`. The worktree was clean before this change. Read-only production inspection confirmed the same source revision, a healthy container, schema 10042, 212 migration records, database integrity OK, and zero foreign-key violations. No production records or configuration were changed.

This is a read-projection and refresh change. It does not change stored Task dates, recurrence, expiration, Rotation advancement, completion authority, or rewards. No migration is required.

## Root cause and corrected contract

The shared `taskScopeWhere` fragment filtered `start_date <= today` without checking `start_time`. Thus Sunday's 19:00 Task was included all Sunday, including 07:30. The personal list also derived its day from the server process timezone rather than the household. List and Kanban rendered that API result; this was not an editor persistence defect.

The corrected board projection resolves the complete Start Date/Time through the existing `taskStartMs` / household-timezone / DST helpers. The same regression fails against the unchanged deployed base and passes against the candidate.

| Case | Normal board behavior |
| --- | --- |
| Sunday 19:00 start | Hidden at 07:30 and 18:59:59.999; eligible at 19:00:00 |
| Start Date without Start Time | Eligible from household-local midnight |
| No Start Date | No start-window restriction; other existing filters still apply |
| Tomorrow / early recurring occurrence | Hidden until its full start instant |
| Overdue or in-progress with a past start | Remains eligible; due dates and status rules are unchanged |
| Future parent or learner source | Its children and generated helper projections cannot appear early |
| Future child of a started parent | Child is omitted; authorized aggregate required/optional progress remains accurate |
| Show scheduled / `include_future=1` | Intentionally exposes future work |
| Calendar, Search, history, direct detail/editor | Existing planning/history access remains available under existing permissions |
| DST spring gap | Existing canonical policy rolls the nonexistent wall time forward |
| DST repeated hour | Existing first-instant policy is used; a Task does not disappear again during the repeated hour |

The request-local projection follows structural ancestry plus canonical supervision source/action links, including a helper counterpart whose own stored window is stale. It does not change those stored windows. Personal and paired-device Task boards use the same projection; Dashboard counts, legacy Wall projections, and MCP ordinary Task lists use it too.

The server returns only `server_now` and the next authorized start instant as refresh metadata. Private/out-of-scope Tasks do not contribute that metadata. Browser-local date parsing and the device's wall clock do not determine visibility.

## Automatic appearance and optimistic feedback

An open Task board schedules one bounded refresh from those two server instants. When the start arrives, it reuses the existing canonical loader and targeted reconciliation. SSE still handles ordinary data changes. No write, fake lifecycle transition, or SSE mutation is required merely because time passed.

Existing focus, visibility, online and page-resume refreshes recover sleeping/offline tabs. Failed timed reads retry at a bounded 30-second interval. Disposed/auth-ended views cannot rearm from late replies. Browser timer throttling and network delay can postpone display until a fresh authorized response arrives; suspended/offline devices cannot be promised an exact real-time paint.

Checkboxes retain their immediate provisional path. A mutation acknowledgement containing the full detail tree cannot reveal future child actions in an already-filtered card. Pending feedback survives list reconciliation, and a later canonical boundary response can reveal newly eligible children even when no Task revision changed. Hidden required work remains in progress denominators and bulk-action confirmations. Existing lifecycle protection still rejects premature execution.

## Focused validation

Runs below overlap and are deliberately not summed into a total.

| Evidence | Result |
| --- | --- |
| Identical same-day router regression on base `555a07e4` | Fails as expected: 19:00 Task appears at 07:30 |
| New scheduling/backend cases | 11/11 passed |
| Final new cases plus existing device-Task and household-timezone suites | 40/40 passed |
| Earlier affected Task-scope, device-app and MCP gate | 82/82 passed; overlaps the new cases |
| Progress, card reconciliation and refresh-timer tests | 37/37 passed |
| Targeted bulk confirmation for hidden scheduled work | 1/1 passed |
| Actual-backend browser acceptance | 1/1 passed; personal and paired List/Kanban across two authenticated clients |

Backend cases include same-day boundaries, date-only/tomorrow/no-start/past starts, early recurrence, parent/helper/action ancestry, nested required/optional/delegated progress, device scope and full response metadata, Dashboard counts, DST gap and overlap, and real shared-Rotation recurring Task creation. Rotation activation does not reveal an unstarted Task; visibility reads leave Track, Occurrence, Task state and revisions unchanged. The graph resolves a root plus 30 actions using at most four SQL reads, with request-local reuse only.

The existing broad `test-task-refinement-ui.js` harness has 11 failures from missing `deviceContext` / `isDevicePrincipal` VM stubs. The identical 11 failures reproduce against the unchanged base. They were not changed or counted as candidate passes. The newly added confirmation test passes independently.

The full-app test uses real personal authentication, device pairing and the application backend in an isolated synthetic household. The household is New York while the browser is Los Angeles. It exercises personal List with paired Kanban, then personal Kanban with paired List. Both automatically reveal the Task without navigation, writes or synthetic SSE after the controlled boundary jump; the Task change-clock stays unchanged. The Show scheduled control and API opt-in work.

The test arms a 1,500 ms server-relative timer, settles reads for 200 ms, then advances only the server clock. Automatic appearance follows the remaining real timer at approximately 1,317 / 1,311 ms after that artificial jump. These numbers demonstrate timer operation; they are not production delay measurements at a normally advancing clock boundary.

Paired-device List and Kanban checkbox state was checked and pending by the second animation frame, at 33.5 / 30.4 ms, while the actual request remained held and the database still said open. Duplicate taps produced one request, and authoritative completion succeeded after release. These are DOM/frame observations, not independent pixel measurements or physical-device latency claims.

Discarded browser setup attempts encountered Express static-path rejection of a `.codex` ancestor, the expected paired-device landing redirect, service-worker startup navigation, and a stalled four-tab cold start. The final fixture copies unchanged runtime files to a safe temporary path and uses two authenticated clients over two view passes. Those setup attempts are not counted as passes or product regressions. The final run had no page errors.

Local evidence: `.qa/task-start-visibility-baseline.log`, `.qa/task-start-visibility-backend.log`, `.qa/task-start-visibility-final-backend.log`, `.qa/task-start-visibility-browser-result.json`, and `.qa/task-start-visibility-20260921/`.

Reproduce the focused checks with:

```text
node --test test/test-task-start-visibility.js test/test-device-tasks.js test/test-household-timezone.js
node --loader ./test/test-browser-loader.mjs --test test/test-task-fields.js test/test-task-card-subtasks.js test/test-task-start-refresh.js
node --test --test-name-pattern="bulk confirmation includes" test/test-task-refinement-ui.js
node --test test/test-task-start-visibility-browser.js
```

## Delivery

Local commit only. No push, deployment, migration, or production household mutation. Physical Kitchen Wall / Fully Kiosk / Apolosign timing has not been tested in this pass.

Verdict: **READY WITH KNOWN LIMITATIONS** for the focused change. New acceptance checks pass; the separately reproduced legacy VM-harness failures and physical-device testing limits are stated above.
