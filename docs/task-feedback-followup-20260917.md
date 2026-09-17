# Task feedback and reusable template dates — 2026-09-17

This local candidate is based on deployed source `4f93b3caefe12f88a648591b59e3c49d46bebaf0`. Scope is expanded-card checkbox feedback and Activity Template Start/Due dates alongside times. No publication or deployment is authorized for this pass. Production was inspected read-only: the image and revision match that SHA, schema is 10036, integrity is OK and foreign-key violations are zero. No real household Tasks were changed for profiling.

## Checkbox discrepancy and cause

The production-equivalent delay is reproducible on expanded Task cards in list and Kanban views. Their handler awaited the status PATCH and then awaited `loadTasks()`. The checkmark was first rendered by that full list reconciliation. There was no optimistic card update. The user's currently open production page was Kanban with a subtask control focused; this is relevant observed UI state, not a claim that the user confirmed every delayed interaction used that surface.

The previous benchmark opened only the Task Details modal. It captured DOM/ARIA/SVG-presence state and logged that captured state at an animation frame. It did not measure the expanded-card handler, reread the actual check path at both frames, or establish pixel presentation. Its approximately 14–16 ms result was not evidence of production-visible latency across all Task surfaces. The earlier report now carries an explicit correction.

The current modal retains its immediate inline-SVG path: corrected full-app modal measurements were already fast before this change. No 500–1000 ms modal-only regression was reproduced. The confirmed slow path was the separate expanded-card control, where visible feedback waited for both HTTP and the subsequent Task-list read. It was not an optimistic checkmark being hidden by pending CSS, an intentional hold/drag delay, or a hundreds-of-milliseconds synchronous checkbox render.

## Corrected measurements

The repeatable opt-in probe is `scripts/task-feedback-full-app-probe.mjs`; its setup and limitations are documented in `test/task-feedback-full-app-probe.md`. It runs the actual application router, CSS, session/CSRF authentication, server, SQLite, schedulers and live events with a fresh synthetic household in isolated Chromium. Fixtures include nine required actions, one optional action, two points, weekday recurrence, expiration, and five-skill supervision/delegation cases. Baseline and candidate use the same fixture order. Fixtures accumulate, so later reads contain a larger household tree, roughly comparable in size to the 204-row production snapshot.

The native matrix has one matched sample for each of seven paths on each of three surfaces: 21 baseline and 21 candidate actions, all HTTP 200. These are samples, not percentile estimates. `HOLD_MS=0` uses the local server without a simulated delay. Separate held-request runs delay dispatch by 500 ms to prove that local feedback is independent of HTTP and live delivery.

The checkbox column below is pointerdown to the **second animation-frame callback with the desired check-path state**. It is a browser frame proxy, not a physical screen measurement. Completion and reopening test opposite desired path states. A completed parent leaving Active is reported separately rather than misreported as a checked frame.

| Surface / path | Checkbox before → after, ms | Local HTTP dispatch → JSON before → after, ms |
| --- | ---: | ---: |
| List: first required / auto-start | 750.6 → 30.6 | 104.2 → 102.2 |
| List: middle required | 863.5 → 30.3 | 98.1 → 104.4 |
| List: optional | 930.3 → 30.9 | 97.4 → 103.6 |
| List: final required / recurring completion | no checked frame before Active removal → 30.6 | 220.9 → 131.2 |
| List: supervised helper | 1140.3 → 30.4 | 166.0 → 171.5 |
| List: delegated helper | 1319.4 → 30.5 | 196.6 → 208.7 |
| List: reopen | 1247.6 → 29.8 | 97.9 → 108.5 |
| Kanban: middle required | 1513.8 → 30.5 | 101.6 → 104.5 |
| Modal: middle required | 30.4 → 30.4 | 102.7 → 103.5 |

Across all fourteen candidate list/Kanban paths, the first frame shows the correct path in about 13–15 ms and the second in about 30–32 ms. Candidate modal second-frame samples span 30–48 ms. Native acknowledgement has not been optimized in this change; differences in these single samples do not establish a backend speedup. Some supervised/delegated acknowledgements remain above 200 ms.

Representative middle-required list timeline, measured from pointerdown:

| Event | Baseline ms | Candidate ms |
| --- | ---: | ---: |
| Pointerup | 0.6 | 0.8 |
| Click | 0.7 | 0.9 |
| Handler entry | 0.7 | 0.9 |
| Optimistic pending-map update | none | 1.3 |
| Check-path DOM observation | 857.5 | 2.2 |
| PATCH dispatch | 1.1 | 2.9 |
| First correct-path frame | 859.3 | 13.9 |
| Second correct-path frame | 863.5 | 30.3 |
| PATCH response headers | 98.0 | 106.7 |
| PATCH JSON received | 99.2 | 107.3 |
| Canonical path reconciliation | part of later list render | 108.0 |
| Surrounding list GET dispatch | 99.5 | 110.9 |
| Surrounding list GET JSON | 838.8 | 806.4 |
| Live event observation | 820.4 | 768.1 |

The roughly 700 ms list read still exists; it no longer gates the checkbox. Raw evidence records pointerup/click, headers, JSON, pending state, path mutations, both live DOM frame samples, row identity/removal, list reconciliation, live invalidation and subsequent reads. No main-thread long tasks were observed in the retained native samples. A separate baseline card trace totals 11.0 ms style work, 3.3 ms layout, 2.6 ms Paint and 5.8 ms raster work across its sample; these costs do not explain the asynchronous list-read wait. They are instrumented whole-sample totals, not uninstrumented tap-to-paint figures.

Separate whole-viewport raster captures show the baseline modal already checked with pending feedback while the baseline card stays empty during the held request. The candidate card shows its pending checkmark before acknowledgement. Initial clipped screenshots moved the layout and were invalid; they are excluded. Tracing and screenshot capture added measurable overhead, so their timing is not mixed into the light native table. Captured raster pixels and animation callbacks do not prove compositor presentation on the user's Android/PWA, Windows display or Fully Kiosk device.

The final separate JPEG screencast captures provide a closer visible-feedback measurement. Successive frames were inspected directly, including the checkbox and progress text:

| Candidate surface | Last captured unchecked frame | First captured checked frame | HTTP JSON from pointer |
| --- | ---: | ---: | ---: |
| Expanded list | +9.88 ms | **+26.96 ms** | approximately +613 ms |
| Kanban | +4.21 ms | **+22.04 ms** | approximately +612 ms |

Both checked frames show the green checkbox, white check, struck-through action title and 5-of-9 required progress. The preceding frames show an empty checkbox and 4-of-9 progress. Their DevTools raster timestamps are aligned to pointerdown through the browser's time origin. The transport was deliberately held for 500 ms. These captured browser pixels support sub-50 ms feedback in the isolated full application independently of acknowledgement; they still do not measure a physical display. Evidence is `candidate-visible-frames/card-required-middle-0-frame-008.jpg` / `009.jpg` and `kanban-required-middle-0-frame-009.jpg` / `010.jpg`, with timestamps in each case JSON. The earlier PNG frame-stream attempt added large capture overhead and one teardown acknowledgement error; it is excluded from successful candidate evidence.

**Actual production HTTPS status acknowledgement is unmeasured in this pass.** The available signed-in browser inspection surface does not expose the required Performance/network timing, and the existing reverse proxy has no access timing log. No production logging/restart, credential extraction or household mutation was introduced to manufacture that measurement. The table is isolated local HTTP, not production HTTPS. This remains a validation limitation.

## Bounded frontend fix

Expanded cards now use the existing serialized, revision-checked subtask queue with a per-card canonical snapshot and provisional child overlay. Persistent inline SVG paths, checkbox classes, required/optional progress and safe provisional In Progress status are patched synchronously. Unchanged metadata and subtask nodes remain in place. Final parent completion, points and recurrence remain canonical server results.

Different child taps paint immediately and queue; duplicate or opposite taps on the same pending child are suppressed. Each dispatch rechecks current eligibility and the original child revision. Only an accepted own acknowledgement can advance a queued parent revision. Newer live state, equal-revision permission changes, rejection, expiration and parent closure cancel unsafe queued work. The actual rejection reason is shown and canonical state is refreshed without retrying a possibly committed write.

Canonical HTTP responses update the card directly. Pending overlays are reapplied synchronously after any surrounding list reconciliation. A saved batch requests one background list refresh. Initiating-client feedback does not wait for SSE. Parent status/drag controls remain exclusive with pending child writes; scroll, expansion and focus are retained where the existing view reconciliation permits. `touch-action: manipulation` applies only to explicit checkbox buttons; activation remains click-based, and the existing card hold/drag logic excludes these controls.

There are no changes to lifecycle, revisions, permissions, supervision, reward accounting, recurrence or expiration algorithms. No authorization cache is introduced. Service-worker cache `vidamia.14` includes the new controller module for a future coherent asset update.

## Activity Template dates

The inspected implementation stored and serialized only `start_time`/`due_time`; its Reusable schedule text explicitly instructed users to choose dates per Task. Save as Template omitted dates, the draft resolver inherited only times, and the template schema had no date columns. Inspection did not find persisted template date columns immediately before the time-field refinement, so this is a missing reusable date path across UI/payload/schema rather than a proven deletion of just two existing widgets.

The editor now exposes Start date | Start time and Due date | Due time, stacking on narrow layouts. Optional date values flow through create/edit/catalog/resolution, Task creation defaults, template selection and Save as Template. Explicit nulls and Blank reset remain supported; selecting a template still uses the established reset/warning behavior. Existing time-only templates retain null dates.

Complete supplied boundaries validate start <= due. Date-aware comparisons permit a Monday-afternoon to Friday-morning window; server validation resolves boundaries through the existing household-timezone/DST helpers. Invalid boundaries use the existing alert/toast and first-invalid-field focus. Time-only templates retain their existing same-day validation. Recurrence weekday selection, expiration, points and Repeat from completion remain unchanged.

An additive migration **10037** adds nullable `activity_templates.start_date` and `due_date`. Migrations 10035 and 10036 are untouched. The encrypted production-shaped 10036 fixture upgrades once, preserves original template/Task rows and migration history, reports integrity OK and zero foreign-key violations, and restarts with no migration replay. This migration has not run in production.

Acceptance coverage includes the same-Monday 07:00–08:00, M–F, two-point expiring morning routine; its Monday expiration awards zero and Tuesday retains 07:00–08:00. The Monday-afternoon to Friday-morning weekly homework window advances intact across the autumn DST boundary. Spring and autumn weekday recurrence tests preserve household-local times. Full-app desktop morning and mobile homework workflows save a template, immediately select it from the existing dropdown without losing the draft, inherit all four boundaries, and create a persisted Task.

## Validation and remaining limits

* Focused backend/lifecycle/recurrence/expiration/security/live/SW gate: **364 passed, one existing baseline failure** out of 365. The old `test-task-subtask-latency-integrity.js:164` assertion expects reopening to erase a reward earn. It fails identically on unchanged deployed source 4f93 because the existing durable-reward model retains that earn. No unrelated reward/test semantics were changed.
* Existing Task Details feedback/optimistic/layout browser regressions: **29 passed**, including rejection, optional/delegated actions, independent-client convergence, touch scrolling and scroll/focus/disclosure preservation.
* Shared queue/card-controller regressions: **33 passed**.
* Additional UI contracts, optional-inspection cost and migration-order checks: **53 passed**.
* New full-app card browser regressions: **6/6 passed in the final consolidated run**, covering rapid sibling taps and duplicate suppression, a real stale-write rejection, optional/final completion with two points and one history/recurrence result, reopening, a second independent live client, and native touch scrolling followed by an intentional tap. A real list read while the second write is held preserves the pending checkmark; the final read preserves row identity, expansion, scroll and focus.
* Template route/draft/date/migration tests: **26 passed**, including encrypted upgrade/restart and date/DST acceptance.
* Mounted template/Task editor browser tests: **20 passed** across desktop/tablet/mobile.
* Full-app template browser regression: **one test passed covering two viewport workflows** (1366 px and 390 px), with saved screenshots inspected.
* Full-app feedback matrix: **42 successful native HTTP interactions**, plus separate held-response/raster evidence. Final required actions assert exactly one parent earn and one recurrence successor.

The first template full-app harness was interrupted by the real service worker's initial install/update reload at eight seconds. The corrected harness waits for that normal startup behavior and runs on an isolated internal network. The initial run is not counted as passing. A missing Docker network on the first card-suite launch is infrastructure failure, also not a pass. Early card-test failures were corrected in the harness: recurrence fixture hooks, parent-only history counting, startup settling, observing service-worker-handled list responses through the app's consumed fetch result, and tracking the actual mobile scroll ancestor. Native touch scrolling cancels the pointer activation and produces no write; a deliberate tap is checked only once its target geometry is stable. No product workaround was added for those harness failures. No physical-device timing or production HTTPS acknowledgement is claimed, and a modal-only 500–1000 ms problem has not been reproduced.

Raw local evidence is retained under `.qa/task-feedback-followup-20260917/` and `.qa/template-dates-20260917/`; repeatable probe/tests are committed. No push, deployment, production migration or production Task mutation occurred.
