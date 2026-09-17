# Task Details checkbox latency — 2026-09-17

Measurement correction from the subsequent investigation: the original full-app
timing harness below sampled a captured DOM/SVG-presence value at rAF, not actual
painted pixels, and covered only the Task Details modal. It did not measure the
expanded list/Kanban subtask controls, which still waited for HTTP acknowledgement
and a list refresh. Those historical timing figures must not be read as proof of
production-visible latency. See `task-feedback-followup-20260917.md` for corrected
full-application measurements, separate raster evidence, and remaining limits.

Scope: completion/reopening feedback and request-local optionality lookup cost. No Task lifecycle, points, recurrence, authorization, migration or production changes. Candidate is based on production source `b55bbe08aa2d6b300fbab33567c3b37545eb4be2`; publication/deployment are expressly excluded.

## Diagnosis and comparison with the earlier optimization

The earlier implementation is `b64c10a6` (merged by `d87accb2`). Its report, `docs/task-subtask-latency-20260913.md`, recorded a control of 13.2 ms visual feedback and 156.1 ms acknowledgement. The old browser measurement observed optimistic DOM/ARIA/progress at an animation frame, which did not prove that the checkbox itself contained a rendered checkmark.

Re-running the old and current components with real Lucide shows **no checkbox SVG in the optimistic frame in either version**. `lucideIcon()` returned an empty `<i data-lucide>`; the pending operational render did not run icon conversion. The canonical full view briefly converted icons, but the final operational render replaced those icons again. The checkbox depended on a later document-wide icon pass, commonly following the server acknowledgement/list refresh. Current successful actions replaced the subtask list three times. This accounts for a visibly late checkbox despite immediate internal state.

The immediate optimistic callback and hydrated HTTP acknowledgement from `b64c10a6` remain present. `41669db09` added viewport capture/restore; `99dcd1fbd` added disclosure capture and richer detail content to these replacements. Synchronous controlled handler/render work increased from roughly 3 ms to 5–7 ms. This is measurable but does not explain a 250–500 ms checkbox delay. Optional-only progress arithmetic and expiration guards did not move the normal optimistic callback behind the server. Task live synchronization retained its one-second change-clock observer and was not made the local acknowledgement path.

The morning refinement (`b55bbe08`) added repeated optional ancestry lookups to supervision inspection. This is a separate backend regression: a required-first request repeated fresh optional context resolution 134 times; a complex final recurring action repeated it 305 times. Expiration checks took only about 0.3–0.7 ms in those cases. Existing authorization/read-projection optimization remains active.

## Implementation

* Checkbox SVG is created synchronously and its check path changes immediately. Pending updates patch existing operational nodes without viewport/layout reads or a document-wide icon scan.
* Required and optional counts use a provisional overlay. Ordinary required first-step completion and required reopening show provisional In Progress. Canonical Task/child state and points remain untouched until acknowledgement. Final Completed remains authoritative because the current read payload does not expose a complete Workflow dependency graph; assuming that all visible required steps imply completion would be unsafe.
* Different child taps paint immediately and enter one serialized revision-checked queue. Same-child duplicate/opposite taps are suppressed while pending. Only an accepted own acknowledgement can advance queued parent revisions; each child's original revision/status and current eligibility are rechecked before dispatch. Newer live state, rejection, expiration, parent closure or uncertain acknowledgement cancels unsafe queued intents without retrying writes.
* Equal-revision acknowledgements cannot overwrite permissions/metadata from a newer accepted live read. Late responses after closure are ignored. Actual rejection reasons are shown; one shared refresh recovers the canonical state after a rejected batch.
* Canonical reconciliation retains subtask rows, checkbox controls, unchanged skill explanations, scroll, focus and disclosure state. Changed skill/supervision content is patched by logical identity. Definition/structural changes retain the existing full-render fallback. Parent lifecycle/edit/archive and other parent writes are exclusive with the child queue.
* Activity/occurrence history refreshes when visible and after a saved batch; closed disclosures refresh on opening. Deferred live comments refresh once on drain. Surrounding Task list refresh runs once per saved batch and does not delay local feedback.
* `touch-action: manipulation` applies to explicit checkbox buttons. Activation still uses normal click semantics, so scrolling does not complete a step. Existing card long-press/drag handling already excludes explicit controls and Task Details; no long-press delay was found in this path.
* Backend optional ancestry reuses authoritative rows **inside one synchronous read-only supervision inspection**. No authorization/eligibility cache crosses an inspection or mutation. Lifecycle guards still read fresh state. Inspection, validation and write counts are unchanged.
* The PWA cache version advances to `vidamia.13` and includes the queue module so a future release installs these assets together.

## Measurement boundaries

Measurements precede product edits. Browser checks use Chromium in an isolated Linux Docker runtime, real application code, fresh synthetic households, normal authentication/sessions/CSRF, database, workers and SSE. No production household data or production mutations. Browser frame measurements observe actual SVG/check-path content at the next animation frame; they are a presentation proxy, not physical-device camera/input latency. Physical phone, wall display and installed-app performance is not measured directly.

Backend instrumentation uses Windows Node 24.19.0, in-memory SQLite and the real Task status route with synthetic actor middleware. There are five measured repetitions after one warm-up per case. It excludes normal session middleware, schedulers and physical disk/network latency; instrumentation adds overhead. Runs are serial. Inclusive nested phase durations overlap and must not be summed. SQL counts omit internal trigger statements, whose execution is included in write duration.

Raw local evidence and harnesses are in `.qa/task-latency-20260917/`. Browser evidence uses three valid samples per path/version, split into matched 18-sample and six-sample segments. No rejected/rate-limited requests appear in the retained samples. Small medians describe this host/fixture, not tail latency or a hardware guarantee.

## Full-app browser before/after

Checkbox columns measure handler entry to the first observed frame containing its actual SVG; ACK measures request dispatch through response JSON receipt. Times are median milliseconds.

| Path | Checkbox before → after | HTTP ACK before → after |
| --- | ---: | ---: |
| Independent required | 125.3 → 12.5 | 69.6 → 57.5 |
| Independent optional | 201.0 → 14.1 | 122.8 → 102.4 |
| First required / auto-start | 209.9 → 13.1 | 125.5 → 106.9 |
| Middle required | 224.5 → 12.9 | 124.3 → 101.8 |
| Final required / parent completion and recurrence | 306.6 → 12.3 | 180.1 → 149.6 |
| Supervised learner action, authorized helper | 430.1 → 13.8 | 310.9 → 195.5 |
| Helper-owned/delegated action | 358.4 → 13.8 | 289.3 → 226.9 |
| Reopen completed step | 196.6 → 14.7 | 117.0 → 121.2 |

Including pointerdown-to-handler, candidate per-path visual medians are **13.5–16.1 ms**. Required progress is updated in that same optimistic frame. Helper acknowledgement still exceeds the preferred 200 ms target. Reopening's three-sample acknowledgement median is 4.2 ms higher; this limited run does not establish an acknowledgement improvement for that path, even though its visible response is immediate and the instrumented backend is faster.

First-required interaction breakdown:

| Phase | Before ms | After ms |
| --- | ---: | ---: |
| Pointerdown → handler | 1.2 | 1.5 |
| Handler → optimistic DOM observation | 4.6 | 1.8 |
| Optimistic DOM observation → next frame | 11.0 | 11.2 |
| Handler → request dispatch | 4.0 | 1.1 |
| Dispatch → response headers | 124.4 | 105.5 |
| Headers → response JSON read | 1.1 | 1.4 |
| ACK → settled reconciliation frame | 17.8 | 6.9 |
| Pointerdown → actual checkbox frame | 211.0 | 15.0 |

The DOM observer runs at a microtask boundary; its timestamp bounds the synchronous optimistic write rather than precisely timing the assignment. It can therefore appear after request dispatch although the DOM changes occurred before it. A held-response regression test verifies the check path and counts before any acknowledgement.

Baseline tail traces show 3–4 whole-list replacements per click (the controlled component shows three); all 24 candidate traces show zero. Focused tests verify exact clicked/untouched row and disclosure identity, scroll and keyboard focus. The early real-app row-identity probe accidentally matched underlying cards, and the corrected tail probe had two inconclusive pre-click identity samples; those fields are not used to claim universal identity retention. Median Activity/comments GET counts inside the retained click windows fall from 1/1 to 0/0; later legitimate live refreshes are outside that count. Existing surrounding-view callbacks still refresh once per saved batch.

Two independent browser processes converge after completion and reopening. Observed initiating-handler-to-other-client convergence was 2420/2412 ms before and 1303/2339 ms after. This includes existing one-second change-clock polling, invalidation, auth refresh and Task read; polling phase makes these samples variable. The polling cadence is unchanged. The initiating client uses its local overlay and canonical HTTP response, independent of SSE.

Controlled touch measurements found about 17.8 ms pointerdown-to-click (including the synthetic press) and 1.6 ms release-to-handler at baseline, not an intentional 250–500 ms click delay. Touch scrolling sends no completion, and the explicit checkbox has no card hold/drag arbitration. Actual physical touch-device/PWA verification remains unperformed.

## Backend before/after

| Path | Server request before → after (ms) | SQL calls before → after |
| --- | ---: | ---: |
| Independent required, two-step Task | 22.50 → 18.91 | 664 → 584 |
| First required, 10-step routine | 40.89 → 31.39 | 1608 → 1288 |
| Middle required | 34.28 → 27.88 | 1409 → 1121 |
| Optional | 35.46 → 27.15 | 1463 → 1175 |
| Final required with recurrence | 72.05 → 58.68 | 2875 → 2274 |
| Reopen required step | 35.92 → 26.47 | 1473 → 1185 |
| Reopen parent containing optional work | 26.31 → 20.39 | 1118 → 862 |
| First required, mixed helper scope | 68.84 → 57.48 | 2322 → 1912 |
| Supervised learner action, authorized helper | 83.87 → 69.16 | 2740 → 2289 |
| Delegated/helper-owned action | 83.06 → 70.11 | 2740 → 2289 |
| Final mixed action with recurrence | 113.13 → 99.34 | 4028 → 3240 |
| Reopen step in mixed helper scope | 64.41 → 49.98 | 2138 → 1769 |

Across all 12 instrumented cases, median request time fell 12–26% and SQL calls fell 12–23%. All 60 measured actions retained identical Task statuses, Task counts, events, awards and successors. Supervision inspection/reconciliation, mutation authorization and SQL-write counts stayed identical. This is reduced duplicate read work, not deferred validation or effects.

### Representative phase breakdown (first required step)

| Inclusive phase | Before ms | After ms |
| --- | ---: | ---: |
| HTTP entry through response finish | 40.886 | 31.386 |
| Status route body | 39.624 | 30.166 |
| Revision validation, two checks | 0.034 | 0.030 |
| Canonical mutation authorization, two checks | 1.039 | 1.046 |
| All capability checks | 3.744 | 3.771 |
| Canonical lifecycle transaction | 27.720 | 18.989 |
| Task/subtask transitions | 2.020 | 2.002 |
| Parent propagation | 8.478 | 5.378 |
| Supervision reconciliation | 11.067 | 7.016 |
| Supervision transition validation | 5.434 | 3.394 |
| All supervision inspections | 24.283 | 14.836 |
| Fresh optional ancestry lookups | 11.527 | 2.153 |
| Expiration checks | 0.345 | 0.328 |
| Points/reward synchronization | 0.046 | 0.047 |
| Completion evidence/history | 0.020 | 0.020 |
| Activity history | 0.086 | 0.081 |
| Recurrence successor processing | 0.114 | 0.132 |
| Notification enqueue (none on this path) | 0 | 0 |
| Native transaction begin | 0.009 | 0.009 |
| Native commit/savepoint release | 0.020 | 0.019 |
| SQL preparation | 24.698 | 18.269 |
| SQL reads | 8.387 | 5.845 |
| SQL writes including triggers | 0.407 | 0.341 |
| Response hydration | 11.043 | 9.961 |
| Serialization/response enqueue | 0.386 | 0.324 |

Additional resolution phases, from the same instrumented samples:

| Phase | First required before → after (ms) | Mixed first before → after (ms) |
| --- | ---: | ---: |
| Task lookup helper | 2.717 → 2.682 | 7.026 → 7.079 |
| Subtask/tree loading helpers | 1.858 → 1.699 | 1.654 → 1.573 |
| Skill requirement lookup | 3.326 → 3.353 | 3.133 → 3.292 |
| Proficiency evaluation | Not invoked | 3.765 → 3.705 |
| Supervisor scope selection | 0.008 → 0.007 | 0.213 → 0.183 |
| Availability/Presence | Not invoked | 12.343 → 12.004 |

These helpers and SQL shapes are retained in `baseline-server-five.jsonl` / `candidate-server-five.jsonl` and the phase reports. Inline supervisor qualification loops are included in supervision inspection rather than independently timed. On the mixed final recurring path, recurrence processing was 49.65 → 42.38 ms, notifications 0.99 → 0.94 ms and native commit/release 0.58 → 0.48 ms. Notifications were not removed or deferred by this change.

Supplemental frozen-baseline/candidate instrumentation isolates pure progress arithmetic (five samples after one warm-up). Parent required/allDone/someProgress/next calculations are 3.8 → 3.2 µs for first, 2.1 → 1.7 µs for middle and 2.4 → 2.1 µs for final required steps. Hydrated progress counters take 4–7 µs total. Timer overhead matters at this scale: no arithmetic speedup is claimed. Progress arithmetic is not the dominant measured cost. All 15 supplemental action outcomes match, including exactly one final parent earn and successor.

## Validation and known limitations

* Backend focused correctness gate: 291/291 pass across revision/permission, start-date, expiration/reopening/races, optional progress, supervision/delegation, recurrence/frontier, reward/history and read-scope freshness suites.
* Frontend unit/service-worker gate: 102/102 pass, including 19 queue tests and PWA cache/precache/API-cache checks.
* Browser regression gate: 29 distinct checks pass (18 existing plus 11 new), including rendered SVG before ACK, first-step provisional status, authoritative final status, required/optional progress, serialized rapid taps, duplicate suppression, stale revisions, equal-revision live permission changes, failed/compatible acknowledgements, supervised/delegated actions, stable disclosures/scroll/focus, touch scrolling, and deferred live comments. Real full-app completion/reopen convergence also passes in two separate browser processes.
* The older latency-integrity suite has one unchanged failure at its reopening/reward assertion (9/10 pass). The same assertion fails on exact baseline `b55bbe08`: it expects reopening to erase earnings, contrary to the existing durable-reward behavior. Neither behavior nor assertion was changed.
* Initial Docker browser live tests had no EventSource because `--network none` makes Chromium report offline. An isolated `--internal` Docker network fixes the harness without an external route or published port. A repeated full-app baseline hit the existing per-IP request limiter and was discarded; final timing uses separate synthetic client addresses through the configured local proxy boundary. Neither event is counted as a candidate regression.
* The old Windows browser-launch infrastructure limitation was avoided with Linux Chromium. Physical device/browser-engine verification remains a release-time follow-up.
* No migration is required. Production remains untouched; no push or deployment is authorized for this pass.

Focused repeatable entry point: `npm run test:task-detail-feedback` (requires a supported Chromium executable for Puppeteer). Backend and browser measurement harnesses, detailed tables and raw traces are retained locally in the evidence directory; the production database is not part of these fixtures. The entire repository/CI suite was not represented as green.
