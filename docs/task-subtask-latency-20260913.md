# Task subtask completion latency — 2026-09-13

Validated locally. Not pushed or deployed. The final source is the commit containing this report; the final handoff records its SHA.

## Reproduction and method

Baseline: deployed image `yuvomi:release-91b8fc31a095f36cb6e82c483b0e76c57aef15ba`, revision `91b8fc31a095f36cb6e82c483b0e76c57aef15ba`.
Candidate: the same Linux Docker runtime/dependencies with the candidate server/public files mounted read-only. The application serves these modules directly; there is no separate frontend compilation step.

A fresh supported encrypted production backup supplied the household configuration, skill/proficiency, Availability/Presence and existing Task data (schema 10033, 80 Tasks). All benchmark actions ran on disposable fixtures in isolated copies, never on production Tasks. Production credentials were not used to sign in: cloned accounts received temporary test credentials only inside the isolated database.

The application container had no outbound network route. A local inbound-only HTTP proxy exposed it to headless Edge on the same household host. Existing application schedulers and real session, CSRF, permissions, Task routes, database triggers and live streams stayed active.

The mixed fixture uses the eight Laundry definitions and explicit skills, actual learner/helper eligibility, and canonical reconciliation. Simple uses two independent steps. Final completion starts with the other steps completed through the canonical lifecycle outside the timed interval and generates the next recurrence.

Browser instrumentation measured click dispatch, fetch headers/body, DOM updates and the next animation frame. QA-only Node preload hooks recorded request-local inclusive/exclusive function timings, SQL operations, native commit/release calls, serialization and SSE writes. Neither profiling hooks nor debug endpoints are shipped.

Two valid samples per case per version; values below are medians in milliseconds, not statistically reliable tail estimates. Initial service-worker installation/reload and rejected rate-limit trials were discarded. Fresh virtual browser devices were separated at the QA proxy without changing application rate limits. Database restores used fresh filenames, avoiding stale SQLite journals. No other test suites ran during the final timing measurements.

## End-to-end measurements

| Case | Visible before | Visible after | ACK before | ACK after |
| --- | ---: | ---: | ---: | ---: |
| Simple independent step | 1168.0 | 13.1 | 1081.0 | 77.6 |
| First step in mixed Laundry | 7168.9 | 14.5 | 3160.5 | 211.0 |
| Supervised step, helper view | 5683.2 | 12.8 | 2244.2 | 222.8 |
| Delegated step, helper view | 4744.8 | 8.6 | 2506.3 | 221.6 |
| Final delegated step + parent/recurrence | 2322.6 | 13.1 | 1424.3 | 228.7 |
| Reopen independent step | 8043.9 | 13.5 | 3257.4 | 191.3 |

Across all final instrumented samples: visible feedback **4.1–15.0 ms**; successful acknowledgement **64.9–256.4 ms**.

Uninstrumented first-step control confirms the result without profiling overhead:

| Measurement | Before | After |
| --- | ---: | ---: |
| Tap → visible completed checkbox | 6407.9 ms | 13.2 ms |
| Tap → successful acknowledgement | 3131.7 ms | 156.1 ms |
| Browser request dispatch/connection queue | 0.8 ms | 0.7 ms |
| Request sent → first response byte | 3127.4 ms | 151.2 ms |
| Response download | 0.6 ms | 0.5 ms |
| ACK → settled canonical paint | 3276.2 ms | 11.7 ms |

These are local HTTP measurements, including the QA proxy. TTFB includes server queueing and processing; it is not a measurement of physical network latency alone. For the instrumented first-step samples, browser ACK minus server request elapsed fell from approximately **1510 ms to 6 ms**. The traces and control show that browser dispatch/download were small; synchronous server work and queued refreshes dominated. Household Wi-Fi, remote access and the production HTTPS endpoint were not latency-benchmarked.

## First mixed-step timing breakdown

Inclusive measurements below overlap: supervision is inside lifecycle/parent work; permissions and SQL also appear inside hydration. Do not sum these rows. Raw traces retain exclusive time and counts.

| Phase | Before ms | After ms |
| --- | ---: | ---: |
| Click handler → request dispatch | 0.30 | 1.90 |
| HTTP entry → response finish | 1650.92 | 204.68 |
| Status route body (including children) | 1102.98 | 151.35 |
| Revision validation (2 checks) | 0.28 | 0.24 |
| Canonical mutation authorization (2 checks) | 4.72 | 4.98 |
| All capability checks, including read hydration | 352.05 | 23.77 |
| Supervision reconciliation (2 calls) | 360.33 | 25.71 |
| Supervision transition validation | 87.76 | 10.02 |
| All full supervision inspections (14 → 10) | 683.38 | 75.11 |
| Canonical lifecycle transaction | 586.74 | 57.56 |
| Task/subtask transition work | 1.37 | 1.54 |
| Parent status propagation, including validation | 131.71 | 15.94 |
| Rewards/points | 0.04 | 0.07 |
| Completion evidence/history | 0.02 | 0.05 |
| Activity logging | 0.12 | 0.13 |
| Recurrence guard on this first-step case | 0.00 | 0.06 |
| Native transaction commit/savepoint release | 3.02 | 2.77 |
| SQL prepare | 216.17 | 40.97 |
| SQL reads | 404.67 | 81.74 |
| SQL writes, including triggered effects | 1.45 | 1.25 |
| Response Task hydration | 507.24 | 85.02 |
| JSON serialization/response enqueue | 2.01 | 4.23 |
| ACK → canonical settled checkbox paint | 4008.35 | 13.00 |

The first step produces no new notification fanout: notification enqueue count was zero in both versions. Existing inbox/notification reads remained reads. Source inspection confirmed notification delivery is queued locally; no external provider delivery runs inside this status mutation. No notification/reward/history work was moved out of the transaction.

The first-step browser trace shows two detail GETs after the old PATCH (the explicit reload plus live invalidation). The final candidate needs no detail GET to acknowledge the action; one later GET remains for live synchronization. The two surrounding list/obligation refreshes still occur in the background. In the representative candidate trace they dispatch at about 208 ms and 837 ms, after the checkbox has already painted and the mutation has been acknowledged. Activity/comments refresh after acknowledgement, without blocking the pending-state paint.

The final-step recurrence path was separately exercised: recurrence work fell from **144.1 ms to 38.9 ms**. Fresh supervisor selection and occurrence creation remain synchronous.

Live publication remains the existing clock observer: committed database triggers advance the clock, and the observer checks it every second. It is not a blocking publish inside the mutation. Two real browser processes converged after completion in **2285 ms** and reopening in **2175 ms**, including the observer, authorization refresh, Task reads and paint. Both obtained matching canonical revisions. A deliberately delayed stale write received 409 and could not replace the winning state.

## Root cause and changes

1. The detail controller ignored the hydrated mutation result, waited for a detail GET, then awaited a full Task-list/obligation refresh. Live invalidation added competing reads. A checkbox could remain unchanged for the whole chain.
2. Supervision repeatedly constructed ICU timezone formatters and recomputed identical proficiency and Availability inputs. The first mixed status request performed 14 full inspections and 6518 public SQL operations.
3. Hydration repeatedly loaded the same actor permissions and Task capabilities. After the first resolver optimization, hydration still took roughly 387 ms and caused competing list reads to delay acknowledgements.

The fix:

- Paint a separate optimistic checkbox/progress projection before request dispatch, after any required confirmation. Show “Saving…”, label pending state accessibly, and block duplicate actions while the original revision is in flight.
- Keep parent status, earned points, history and saved Task data canonical. Accept the hydrated source/helper parent response only if its revision is current. Invalidate older pending reads; a newer live snapshot always wins.
- Remove only the optimistic overlay on rejection and show the actual server reason. A successful old-compatible response followed by a failed refresh keeps the acknowledged child and blocks further writes until the parent revision is refreshed, with an explicit “saved, refresh required” message.
- Refresh surrounding lists independently of the acknowledged detail action. Real live refresh remains enabled.
- Include the independently authorized helper-parent projection in helper status responses, using the same response-local supervision view.
- Reuse bounded immutable timezone formatters, never timezone settings or time-dependent decisions.
- Reuse identical proficiency and Availability facts only within one synchronous inspection. Remove two redundant inspections per reconciliation while retaining fresh initial/final validation and mutation-time supervision gates.
- Reuse permissions/capabilities only during synchronous read hydration, scoped to connection and actor. Return defensive copies; clear on writes; bypass caching inside transactions/savepoints and canonical mutation authorization; discard the scope afterward. Missing/draft records are not cached.

First mixed-step SQL operations fell **6518 → 2004**, full inspections **14 → 10**, and response hydration **507 → 85 ms**. Canonical permission and revision checks remain present. No Task lifecycle, ownership, assignment, duration, reward, recurrence or availability semantics changed. No migration was added.

## Validation

**621 tests passed; 0 failed; 0 skipped**, across 38 targeted files. This includes **44 added regressions** and **8 real-component/browser tests**. Three additional production-shaped browser/SSE checks passed.

Coverage includes duplicate taps; complete/reopen races; stale reset and reassignment; source/helper races; atomic supervision rejection; permission isolation and revocation; transaction/savepoint rollback; optimistic rejection and failed refresh; current-revision recovery; first-step auto-start; final delegated completion; once-only rewards/history/recurrence; supervisor ownership and zero-point helper projections; real live convergence; Availability, overnight/timezone/DST behavior; Calendar/CalDAV; notification/read safety; mobile/keyboard/focus behavior.

The gate also repaired an existing revision-test setup error: it now builds only migrations preceding 10032 before testing 10032, instead of incorrectly applying 10033 first. Its 11 checks pass. Initial gate harness retries established the required external in-memory DB/session environment; the clean final matrix uses that environment. An initial import touched the ignored empty-Task worktree test database (0 Tasks), not production; it was left intact.

A separate historical `test-detail-view.js` suite has four obsolete source-pattern assertions that also fail at the exact baseline. They were not rewritten as unrelated UI work, and a full repository-wide npm test pass is not claimed.

Focused rerun: `npm run test:task-subtask-latency` with the repository-supported Node runtime and an available Puppeteer/Edge browser. The complete matrix command/file list is retained with the ignored QA evidence.

## Evidence and limits

Ignored evidence: `.qa/task-latency-20260913T145316/`.
- `server-baseline-clean.jsonl`, `server-after-final.jsonl`: full request/SQL/SSE phase traces.
- `browser-baseline-clean.json` plus valid `browser-baseline-supplement.json`: before samples.
- Valid simple/first/supervised rows in `browser-after-final.json` plus `browser-after-supplement.json`: final after samples.
- `browser-before-control.json`, `browser-after-control.json`: uninstrumented controls and Resource Timing.
- `summary.json`, `live-browser.json`, `final-tests.log`, `run-gate.ps1`: calculations, real live checks, final gate and exact test list.
- Fresh encrypted source snapshot and per-run database copies remain ignored and are not committed.

The sample size is small and local. This establishes the bottleneck and improvement, not a WAN/mobile-device percentile guarantee. Other clients still use the existing full-read invalidation cadence (about 2.2 seconds in this check). No permanent profiler, new background job, asynchronous correctness shortcut, production data mutation, push or deployment was introduced.
