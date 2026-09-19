# Rotation Groups local validation

Starting source: `cf4b5e2de9f0f7e8b1fd6523d6ec397c0fa12bd4`. This is a local implementation and validation record, not a production release gate. No production database, configuration, image or deployment was changed.

## Implemented contract

- Household Automation Group management uses actual ordered household memberships with stable identities, revisions, deactivation, accessible handle reordering, independent consumer usage and contextual history.
- One canonical service owns Round Robin, Rotating Order and Fixed Order; Track advancement, skips, overrides, correction and pure previews. Database uniqueness, immediate transactions and revisions protect retries and competing writers.
- Activity Templates copy reusable configuration into independent recurring definitions. One explicit parent Activity or Workflow owns the shared occurrence inherited by its children. Separate series do not share a Track merely because they use the same Template or Group.
- Both series edit scopes preserve progress and history. Immutable future Rotation snapshots and future Tasks with activity are reported as exceptions. Pending materialized work resolves from its registered generation when its predecessor settles; older preserved configuration cannot revert the canonical Track.
- Typed Variables and expressions read trusted snapshots without mutation. Workflow request identity makes retries reuse committed results. Capability checks cover previews, creation, contextual outcomes and retries.
- Meal chooser/cook/supervisor roles can consume independent canonical Tracks. Existing alias-based configuration remains compatible and shares the canonical selection helper; no household membership is guessed from an old alias.
- Authenticated live invalidation carries versions, not household payloads. Task, Wall, Reader, MCP and integration boundaries preserve their existing visibility rules.

See [architecture and service contract](rotation-groups-design.md), [Task integration](rotation-task-integration.md), [Variables and Workflows](rotation-variables-workflows.md), and [Meal compatibility](rotation-meals-compatibility.md).

## Migration

Only additive migration **10039** is introduced. Deployed migrations through **10038**, including relative scheduling and recurring-series storage, are unchanged.

The rehearsal uses an encrypted synthetic database built through 10038 and populated with completed, expired and partially completed Tasks, optional actions, comments, durable rewards, recurring definitions, Templates, Workflow variables and legacy assignment cursors. It checks every existing table's prior columns/rows, explicit indexes/triggers, consumed identities, integrity and foreign keys. Exactly 10039 applies; restart applies none. This is production-shaped synthetic evidence, not a copy of the current production database.

## Verified acceptance

- Four shared nights resolve Grace/Eleanor/Frankie, Eleanor/Frankie/Grace, Frankie/Grace/Eleanor, then wrap. Child completions do not multiply advancement.
- Shower Order, Meal Chooser and other Tracks sharing one Group advance independently.
- Membership insert/remove/reorder and permanent household departure preserve deterministic next identity and historical snapshots. Temporary unavailability respects keep-position/skip policy. Deleted eligibility references fail closed with an explanation.
- Overrides preserve original results, recheck current eligibility and affect the planned next position by explicit policy. Administrative correction cannot be overwritten by an older pending finalizer.
- Worker-thread races cover duplicate resolution/finalization, override/finalize, correction/finalize and Group edit/resolution. Task transaction failures roll back Rotation changes with the Task mutation.
- Existing scheduling, expiration, Optional actions, supervision, rewards and recurrence retain their established lifecycle. Expiration skips without success awards or unintended advancement.
- Desktop and touch browser tests cover handle dragging, ordinary rapid scrolling, keyboard reordering, drafts, stale revisions, contextual history, pending mutations and two-client live updates.

## Evidence gates

Evidence logs are local ignored artifacts under `.qa/`; repeatable tests and the performance probe are committed with the implementation. Counts below describe individual gates and overlap; they must not be added as a unique-test total.

| Gate | Result | Evidence |
| --- | --- | --- |
| Final combined Rotation service/API/consumer/security/concurrency/migration suite | **105/105 passed**, no skips | `rotation-final-backend.log`; repeat with `npm run test:rotations` |
| Core, adversarial, consumer privacy, authenticated live, encrypted migration, append-only/schema checks | 51/51 passed | `rotation-core-final-gate.log` |
| Task Rotation, materialized futures, existing generation/races and scope messaging | 47/47 passed | `task-rotation-future-gate.log` |
| Meal integration and compatibility, including desktop/touch editor | 146/146 passed | `rotation-groups-20260919/meal-final-gate.log` |
| Group and Meal desktop/touch UI final gate | 19/19 passed | `rotation-ui-final-gate.log` |
| Workflow/Rotation security, cached HTTP replay, Wall/Reader/MCP and scoped integrations | 11/11 passed | `rotation-security-final.log` |
| Existing idempotency and affected Workflow compatibility | 48/49; remaining failure reproduced on unchanged baseline | `rotation-security-compat-final.log`, `rotation-idempotency-baseline.log` |
| Existing series, Optional lifecycle, draft and supervision regression gate | 83/83 passed | Direct runner output, session 89357; part of 98/98 including then-current Rotation cases |
| Existing Task projection/cache gate | 16/16 passed | Direct runner output, session 82557; its separate Rotation fixture failure was corrected and rerun |
| Full application card feedback, including attached Rotation context, rejection, duplicate taps, points/recurrence, two clients and touch scrolling | 6/6 passed | `rotation-card-final.log` |
| Final runtime after HTTP-cache guard: desktop pending/deduplication and mobile scroll/tap smoke | 2/2 passed | `rotation-runtime-final-smoke.log` |

The 83-case existing gate contains `test-task-series-edits`, `test-task-optional-lifecycle`, `test-task-draft`, `test-task-edit-scope`, and `test-task-supervision-refresh`. The 16-case gate contains `test-task-read-projection-cache`, `test-task-supervision-request-cache`, and `test-task-optional-inspection-cost`. These two older command outputs were not saved to log files; their provenance is stated rather than inventing artifacts.

## Checkbox performance

The existing full-application probe now accepts `ROTATION=1` to attach a canonical shared purpose to each synthetic routine. The measured Task/client source was unchanged by the subsequent HTTP-header authorization fix; that fix affects cached POST retries and is covered by its separate integration tests.

- Fourteen List/Kanban paths with Rotation context (first/middle/optional/final required, supervised/delegated helper and reopen) returned HTTP 200. Pointer to first correct animation-frame observation was 14.5–15.4 ms; second-frame observation was 31.1–32.0 ms. No long tasks were observed. These are DOM/frame observations, not physical-display measurements.
- Separately inspected browser raster captures show the changed middle checkbox and required progress by **38.8 ms in List** and **24.3 ms in Kanban**. The preceding captures at 18.8/8.2 ms were still unchanged. HTTP acknowledgement was deliberately held until approximately 544/534 ms, proving the initiating UI did not wait for HTTP or SSE.
- Six native local middle-step samples without transport holding acknowledged in **29.6–37.1 ms** (List median 33.4 ms; Kanban median 31.1 ms). These use the synthetic local server, not production HTTPS.
- The same candidate without attached Rotation context reached the second correct frame in 30.9–31.9 ms across 14 paths. This is an on/off consumer-context comparison, not a new before/after measurement of the starting commit.

Evidence: `.qa/rotation-performance/{candidate-light,rotation-held-light,rotation-native-light,rotation-raster}/results.json`; inspected frames are List `008/009/010` and Kanban `008/009/010` in `rotation-raster`. The observed feedback remains below the 50 ms target.

Final source verification matched all 37 changed/new runtime files to the final non-hidden runtime snapshot. All 57 changed/new JavaScript files parsed, and `git diff --check` passed. The only runtime-file differences from the performance snapshot were the two HTTP-cache/Workflow authorization files; their affected security/compatibility gates and final full-app smoke were rerun. Source hashes are recorded in `.qa/rotation-final-source.json` and runtime manifests.

## Known baseline and infrastructure results

- Two existing Workflow regressions reproduce on immutable starting source: a supervision title expectation (`Help SAM cook` versus `Supervise Cook SAM`), and a launcher extraction fixture missing `activityTimingFields`. The earlier affected backend run was 93/95, not an all-green run.
- An existing native Skill `<summary>` keyboard setup test timed out intermittently on both candidate and immutable starting source. The directly affected tests pass; the failed attempt is not counted as a pass.
- Three existing suite-registration checks fail identically on starting source and candidate because older unrelated tests/scripts are unregistered. New Rotation backend/browser tests are registered in their appropriate chains.
- The existing idempotency route-extraction fixture fails with `taskRevision is not defined` on both starting source and candidate. The actual middleware and newly added authorization/retry cases pass.
- Full-app tests initially received HTTP 500 before interaction because Express's SPA fallback refuses an absolute path under the hidden `.codex` ancestor. The same source served correctly from a disposable non-hidden directory. No application routing workaround was added. Failed launches do not count as passes.
- One Task test attempt received a Windows-assigned Fetch-reserved port before any API request. Its isolated fixture now chooses a usable ephemeral port; the succeeding gate ran all assertions.

## Compatibility limits

- The current product has one household per database. Rotation uses that existing boundary; this is not a new multi-tenant account architecture.
- Sharing across child Tasks requires an explicit owning Activity/Workflow occurrence. Independent pre-existing child series are not silently joined by title, date or Template.
- Legacy synchronized Task assignment cohorts remain their calendar-assignment model. Legacy Meal aliases retain cursor persistence because existing travel reconciliation can rewind an untouched pending tail. The selection algorithm is shared, not duplicated.
- Meal Group allocation finalizes when the dated Meal is generated, including future planning. Later Meal reassignment changes the consumer's audited assignment, not finalized Rotation history. Existing Meal week/status reads may materialize output; new Rotation preview/history and expressions are read-only.
- Group membership is bounded to 100 members, matching the typed collection limit. Empty/inactive/unavailable configurations never select an ineligible member or consume a turn.
- Browser automation uses local Chromium/Edge and touch emulation. Physical phone/wall-device timing and production HTTPS behavior are not measured in this local pass. Validation reduces risk; it cannot establish that all possible bugs are absent.
